import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const codexEndpoint = "https://chatgpt.com/backend-api/codex/responses";
const codexAuthFile =
  process.env.CODEX_AUTH_FILE || path.join(os.homedir(), ".codex", "auth.json");
const botConfigFile =
  process.env.BOT_CONFIG_FILE || path.join(process.cwd(), "config", "bot.config.json");

function normalizeModelName(name) {
  if (name === "5.3-codex") {
    return "gpt-5.3-codex";
  }

  return name;
}
const defaultSystemPrompt =
  "You are a concise and helpful Slack assistant. Continue the conversation naturally using the thread context.";

async function readCodexAuth() {
  const content = await fs.readFile(codexAuthFile, "utf8");
  const parsed = JSON.parse(content);
  const accessToken = parsed?.tokens?.access_token;
  const accountId = parsed?.tokens?.account_id || undefined;

  if (!accessToken) {
    throw new Error("codex auth token not found. Run: codex auth login");
  }

  return { accessToken, accountId };
}

async function readBotConfig() {
  try {
    const content = await fs.readFile(botConfigFile, "utf8");
    const parsed = JSON.parse(content);

    if (typeof parsed?.systemPrompt === "string" && parsed.systemPrompt.trim()) {
      return { systemPrompt: parsed.systemPrompt.trim(), source: "file" };
    }
  } catch (_error) {
    // Fallback to default prompt when config file is absent or invalid.
  }

  return { systemPrompt: defaultSystemPrompt, source: "default" };
}

function toResponsesInput(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  for (const item of response?.output || []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content?.text?.trim()) {
        return content.text.trim();
      }
    }
  }

  return "";
}

function extractOutputTextFromEvent(event) {
  if (typeof event?.output_text === "string" && event.output_text.trim()) {
    return event.output_text.trim();
  }

  if (event?.response) {
    return extractOutputText(event.response);
  }

  return extractOutputText(event);
}

function parseSseResponse(raw) {
  let deltaText = "";
  let fallbackText = "";

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltaText += event.delta;
      continue;
    }

    const maybeText = extractOutputTextFromEvent(event);
    if (maybeText) {
      fallbackText = maybeText;
    }
  }

  return deltaText.trim() || fallbackText.trim();
}

async function parseSseStream(stream, onDelta) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaText = "";
  let fallbackText = "";

  const handleEventBlock = async (block) => {
    const lines = block.split("\n");
    const dataLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        dataLines.push(trimmed.slice(5).trim());
      }
    }

    if (!dataLines.length) {
      return;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      return;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltaText += event.delta;
      if (onDelta) {
        await onDelta(event.delta, deltaText);
      }
      return;
    }

    const maybeText = extractOutputTextFromEvent(event);
    if (maybeText) {
      fallbackText = maybeText;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const splitIndex = buffer.indexOf("\n\n");
      if (splitIndex === -1) {
        break;
      }

      const block = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      await handleEventBlock(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await handleEventBlock(buffer);
  }

  return deltaText.trim() || fallbackText.trim();
}

export async function createAiResponse(context, options = {}) {
  const { onDelta, model: requestedModel } = options;
  if (typeof requestedModel !== "string" || !requestedModel.trim()) {
    throw new Error("model is required for createAiResponse");
  }

  const { accessToken, accountId } = await readCodexAuth();
  const botConfig = await readBotConfig();
  const effectiveModel = normalizeModelName(requestedModel.trim());
  const body = {
    model: effectiveModel,
    instructions: botConfig.systemPrompt,
    tools: [
      { type: "web_search" },
    ],
    input: toResponsesInput(context),
    store: false,
    stream: true
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/"
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const res = await fetch(codexEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const raw = await res.text();
    const payload = (() => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    })();
    const detail =
      payload?.detail?.message || payload?.detail?.code || payload?.error?.message || payload?.error || raw;
    throw new Error(`Codex request failed: ${detail}`);
  }

  if (res.body) {
    return parseSseStream(res.body, onDelta);
  }

  const raw = await res.text();
  if (raw.includes("data:")) {
    return parseSseResponse(raw);
  }

  const payload = (() => {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })();

  return extractOutputText(payload);
}

export function getAiConfig() {
  return {
    authMode: "codex",
    codexAuthFile,
    botConfigFile
  };
}

export async function getSystemPromptInfo() {
  const config = await readBotConfig();
  const fullPrompt = config.systemPrompt;
  const preview = config.systemPrompt.replace(/\s+/g, " ").trim().slice(0, 120);
  const previewEscaped = preview
    .split("")
    .map((char) => {
      const code = char.codePointAt(0);
      if (typeof code !== "number") {
        return char;
      }

      if (code < 128) {
        return char;
      }

      return `\\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");

  return {
    source: config.source,
    file: botConfigFile,
    length: config.systemPrompt.length,
    fullPrompt,
    preview,
    previewEscaped
  };
}
