import SlackBolt from "@slack/bolt";
import { createAiResponse } from "../ai.js";

const { App, SocketModeReceiver } = SlackBolt;

export async function startSlackBot(config, options) {
  const { maxThreadHistory, slackStreamUpdateMs } = options;
  const receiver = new SocketModeReceiver({
    appToken: config.appToken
  });

  const app = new App({
    token: config.botToken,
    receiver
  });

  let botUserId = null;

  function cleanSlackText(text = "") {
    return text
      .replace(/<@[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isFromBot(event) {
    return (
      event.subtype === "bot_message" ||
      Boolean(event.bot_id) ||
      Boolean(botUserId && event.user === botUserId)
    );
  }

  function isMentioningBot(text = "") {
    return Boolean(botUserId && text.includes(`<@${botUserId}>`));
  }

  function isDirectMessage(event) {
    return event.channel_type === "im";
  }

  const slackMaxLength = 20000;

  function toSlackText(text = "") {
    const trimmed = text.trim();
    if (!trimmed) {
      return ".";
    }

    if (trimmed.length <= slackMaxLength) {
      return trimmed;
    }

    return trimmed.slice(0, slackMaxLength);
  }

  function splitSlackText(text = "") {
    const trimmed = text.trim();
    if (!trimmed) {
      return ["."];
    }

    if (trimmed.length <= slackMaxLength) {
      return [trimmed];
    }

    const chunks = [];
    for (let i = 0; i < trimmed.length; i += slackMaxLength) {
      chunks.push(trimmed.slice(i, i + slackMaxLength));
    }
    return chunks;
  }

  function isMsgTooLong(error) {
    return error?.data?.error === "msg_too_long";
  }

  async function buildThreadContext(client, event) {
    if (isDirectMessage(event) && !event.thread_ts) {
      try {
        const history = await client.conversations.history({
          channel: event.channel,
          limit: maxThreadHistory
        });

        const messages = [...(history.messages || [])].reverse();
        const context = [];

        for (const message of messages) {
          if (message.subtype && message.subtype !== "bot_message") {
            continue;
          }

          const text = cleanSlackText(message.text);
          if (!text) {
            continue;
          }

          const isAssistant =
            (botUserId && message.user === botUserId) || Boolean(message.bot_id);

          context.push({
            role: isAssistant ? "assistant" : "user",
            content: text
          });
        }

        return context;
      } catch (error) {
        console.error("[slack][dm_context] history load failed, fallback to current message", error);
        const fallbackText = cleanSlackText(event.text || "");
        return fallbackText ? [{ role: "user", content: fallbackText }] : [];
      }
    }

    const threadTs = event.thread_ts || event.ts;
    const replies = await client.conversations.replies({
      channel: event.channel,
      ts: threadTs,
      limit: maxThreadHistory
    });

    const messages = replies.messages || [];
    const context = [];

    for (const message of messages) {
      const text = cleanSlackText(message.text);
      if (!text) {
        continue;
      }

      const isAssistant =
        (botUserId && message.user === botUserId) || Boolean(message.bot_id);

      context.push({
        role: isAssistant ? "assistant" : "user",
        content: text
      });
    }

    return context;
  }

  async function hasBotReplyInThread(client, event) {
    if (!event.thread_ts) {
      return false;
    }

    const replies = await client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      limit: maxThreadHistory
    });

    return (replies.messages || []).some(
      (message) => botUserId && message.user === botUserId && message.ts !== event.ts
    );
  }

  async function handleConversationEvent({ event, client, say, source }) {
    let replyTs = null;
    const threadTs = event.thread_ts || event.ts;
    const inDm = isDirectMessage(event) && !event.thread_ts;
    let addedEyesReaction = false;
    let pendingUpdate = null;
    let streamedText = "";
    let currentMsgOffset = 0;

    const postMessage = async (text) => {
      const content = toSlackText(text);
      try {
        return await client.chat.postMessage({
          channel: event.channel,
          ...(inDm ? {} : { thread_ts: threadTs }),
          text: content,
          parse: "none",
          mrkdwn: true
        });
      } catch (error) {
        if (!isMsgTooLong(error)) {
          throw error;
        }
        return await client.chat.postMessage({
          channel: event.channel,
          ...(inDm ? {} : { thread_ts: threadTs }),
          text: content.slice(0, Math.floor(content.length / 2)) || ".",
          parse: "none",
          mrkdwn: true
        });
      }
    };

    try {
      try {
        await client.reactions.add({
          channel: event.channel,
          timestamp: event.ts,
          name: "eyes"
        });
        addedEyesReaction = true;
      } catch (error) {
        console.error("[slack][reaction_add] skipped", error?.data || error);
      }

      const context = await buildThreadContext(client, event);
      const lastUserMessage = [...context].reverse().find((msg) => msg.role === "user");

      if (!lastUserMessage) {
        await say({
          text: "질문을 같이 보내주세요. 예: `@bot 오늘 할 일 정리해줘`",
          thread_ts: event.thread_ts || event.ts
        });
        return;
      }
      let lastUpdateAt = 0;

      const updateReply = async (text, force = false) => {
        if (!replyTs) {
          return;
        }

        const now = Date.now();
        if (!force && now - lastUpdateAt < slackStreamUpdateMs) {
          return;
        }

        const content = toSlackText(text);
        try {
          await client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: content,
            parse: "none",
            mrkdwn: true
          });
        } catch (error) {
          if (!isMsgTooLong(error)) {
            throw error;
          }
          const mid = Math.floor(content.length / 2);
          await client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: content.slice(0, mid) || ".",
            parse: "none",
            mrkdwn: true
          });
          currentMsgOffset += mid;
          const reply = await postMessage(content.slice(mid));
          replyTs = reply.ts;
        }
        lastUpdateAt = now;
      };

      const scheduleUpdate = () => {
        if (pendingUpdate) {
          return;
        }

        pendingUpdate = setTimeout(async () => {
          pendingUpdate = null;
          try {
            await updateReply(streamedText.slice(currentMsgOffset), true);
          } catch (error) {
            console.error("[slack][message_update] error", error);
          }
        }, slackStreamUpdateMs);
      };

      const answer =
        (await createAiResponse(context, {
          model: config.model,
          webSearch: config.webSearch,
          systemPrompt: config.systemPrompt,
          onDelta: async (_delta, fullText) => {
            streamedText = fullText;
            const currentText = streamedText.slice(currentMsgOffset);

            if (!replyTs && currentText.trim()) {
              const reply = await postMessage(currentText);
              replyTs = reply.ts;
              lastUpdateAt = Date.now();
              return;
            }

            if (currentText.length > slackMaxLength && replyTs) {
              await updateReply(currentText, true);
              currentMsgOffset += slackMaxLength;
              const overflowText = streamedText.slice(currentMsgOffset);
              if (overflowText.trim()) {
                const reply = await postMessage(overflowText);
                replyTs = reply.ts;
                lastUpdateAt = Date.now();
              }
              return;
            }

            if (Date.now() - lastUpdateAt >= slackStreamUpdateMs) {
              await updateReply(currentText, true);
            } else {
              scheduleUpdate();
            }
          }
        })) || "응답을 생성하지 못했어요.";

      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      const finalText = answer || streamedText || "응답을 생성하지 못했어요.";
      const remainingText = currentMsgOffset > 0
        ? streamedText.slice(currentMsgOffset)
        : finalText;
      const finalChunks = splitSlackText(remainingText);

      if (replyTs) {
        await updateReply(finalChunks[0], true);
      } else {
        const reply = await postMessage(finalChunks[0]);
        replyTs = reply.ts;
      }

      for (let i = 1; i < finalChunks.length; i++) {
        await postMessage(finalChunks[i]);
      }

    } catch (error) {
      console.error(`[slack][${source}] error`, error);
      if (replyTs) {
        const errorSuffix = "\n\n⚠️ 출력 중 에러가 발생했습니다.";
        let errorText;
        const currentStreamedText = streamedText.slice(currentMsgOffset);
        if (currentStreamedText.trim()) {
          const maxContent = slackMaxLength - errorSuffix.length;
          errorText = currentStreamedText.trim().slice(0, maxContent) + errorSuffix;
        } else {
          errorText = "에러가 발생했습니다. 잠시 후 다시 시도해주세요.";
        }
        try {
          await client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: errorText,
            parse: "none",
            mrkdwn: true
          });
        } catch (updateError) {
          if (isMsgTooLong(updateError)) {
            await client.chat.update({
              channel: event.channel,
              ts: replyTs,
              text: errorText.slice(0, Math.floor(errorText.length / 2)) || ".",
              parse: "none",
              mrkdwn: true
            });
          }
        }
        return;
      }

      if (inDm) {
        await client.chat.postMessage({
          channel: event.channel,
          text: "에러가 발생했습니다. 잠시 후 다시 시도해주세요.",
          parse: "none",
          mrkdwn: true
        });
        return;
      }

      await say({
        text: "에러가 발생했습니다. 잠시 후 다시 시도해주세요.",
        thread_ts: threadTs,
        parse: "none",
        mrkdwn: true
      });
    } finally {
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      if (addedEyesReaction) {
        try {
          await client.reactions.remove({
            channel: event.channel,
            timestamp: event.ts,
            name: "eyes"
          });
        } catch (error) {
          console.error("[slack][reaction_remove] skipped", error?.data || error);
        }
      }
    }
  }

  app.event("app_mention", async ({ event, client, say }) => {
    console.log("[slack][event] app_mention", {
      name: config.name,
      channel: event.channel,
      channel_type: event.channel_type,
      ts: event.ts
    });
    await handleConversationEvent({ event, client, say, source: "app_mention" });
  });

  app.event("message", async ({ event, client, say }) => {
    console.log("[slack][event] message", {
      name: config.name,
      subtype: event.subtype || null,
      channel: event.channel,
      channel_type: event.channel_type,
      thread_ts: event.thread_ts || null,
      ts: event.ts
    });

    if (event.subtype && event.subtype !== "thread_broadcast") {
      return;
    }

    if (isFromBot(event)) {
      return;
    }

    const inDm = isDirectMessage(event);

    if (inDm) {
      await handleConversationEvent({ event, client, say, source: "message_im" });
      return;
    }

    if (!event.thread_ts) {
      return;
    }

    if (isMentioningBot(event.text || "")) {
      return;
    }

    const shouldReply = await hasBotReplyInThread(client, event);
    if (!shouldReply) {
      return;
    }

    await handleConversationEvent({ event, client, say, source: "message" });
  });

  app.error((error) => {
    console.error("[slack][app_error]", error);
  });

  const auth = await app.client.auth.test({ token: config.botToken });
  botUserId = auth.user_id || null;
  await app.start();
  console.log(
    `[slack] started name=${config.name} bot_user=${botUserId} model=${config.model || "default"} web_search=${config.webSearch} system_prompt=${config.systemPrompt ? "service" : "default"}`
  );

  return {
    async stop() {
      await app.stop();
      console.log(`[slack] stopped name=${config.name}`);
    }
  };
}
