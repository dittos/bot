import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createAiResponse } from "../ai.js";

export async function startDiscordBot(config, options) {
  const { maxThreadHistory, discordStreamUpdateMs } = options;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  function cleanDiscordText(text = "", botUserId) {
    return text.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").replace(/\s+/g, " ").trim();
  }

  async function buildContext(message, botUserId) {
    const fetched = await message.channel.messages.fetch({ limit: maxThreadHistory });
    const messages = [...fetched.values()].reverse();
    const context = [];

    for (const msg of messages) {
      if (msg.author?.bot && msg.author.id !== botUserId) {
        continue;
      }

      const text = cleanDiscordText(msg.content || "", botUserId);
      if (!text) {
        continue;
      }

      context.push({
        role: msg.author?.id === botUserId ? "assistant" : "user",
        content: text
      });
    }

    return context;
  }

  const discordMaxLength = 2000;

  function capDiscordText(text = "") {
    const trimmed = text.trim();
    if (!trimmed) {
      return ".";
    }

    if (trimmed.length <= discordMaxLength) {
      return trimmed;
    }

    return trimmed.slice(0, discordMaxLength);
  }

  function splitDiscordText(text = "") {
    const trimmed = text.trim();
    if (!trimmed) {
      return ["."];
    }

    if (trimmed.length <= discordMaxLength) {
      return [trimmed];
    }

    const chunks = [];
    for (let i = 0; i < trimmed.length; i += discordMaxLength) {
      chunks.push(trimmed.slice(i, i + discordMaxLength));
    }
    return chunks;
  }

  function isDiscordTooLong(error) {
    return error?.code === 50035 || String(error?.message || "").includes("2000 or fewer");
  }

  client.on("messageCreate", async (message) => {
    if (!client.user) {
      return;
    }

    if (message.author?.bot) {
      return;
    }

    const isDm = message.channel.type === 1;
    const mentioned = message.mentions.has(client.user);

    if (!isDm && !mentioned) {
      return;
    }

    let replyMessage = null;
    let pendingUpdate = null;
    let lastUpdateAt = 0;
    let addedReaction = false;
    let streamedText = "";
    let currentMsgOffset = 0;

    try {
      try {
        await message.react("👀");
        addedReaction = true;
      } catch (error) {
        console.error("[discord][reaction_add] skipped", error);
      }

      const context = await buildContext(message, client.user.id);
      const lastUserMessage = [...context].reverse().find((msg) => msg.role === "user");
      if (!lastUserMessage) {
        await message.reply("질문을 같이 보내주세요.");
        return;
      }

      const updateReply = async (text, force = false) => {
        if (!replyMessage) {
          return;
        }

        const now = Date.now();
        if (!force && now - lastUpdateAt < discordStreamUpdateMs) {
          return;
        }

        const content = capDiscordText(text);
        try {
          await replyMessage.edit(content);
        } catch (error) {
          if (!isDiscordTooLong(error)) {
            throw error;
          }
          const mid = Math.floor(content.length / 2);
          await replyMessage.edit(content.slice(0, mid) || ".");
          currentMsgOffset += mid;
          replyMessage = await message.channel.send(capDiscordText(content.slice(mid)));
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
            console.error("[discord][message_update] error", error);
          }
        }, discordStreamUpdateMs);
      };

      const answer =
        (await createAiResponse(context, {
          model: config.model,
          webSearch: config.webSearch,
          systemPrompt: config.systemPrompt,
          onDelta: async (_delta, fullText) => {
            streamedText = fullText;
            const currentText = streamedText.slice(currentMsgOffset);

            if (!replyMessage && currentText.trim()) {
              replyMessage = await message.reply(capDiscordText(currentText));
              lastUpdateAt = Date.now();
              return;
            }

            if (currentText.length > discordMaxLength && replyMessage) {
              await updateReply(currentText, true);
              currentMsgOffset += discordMaxLength;
              const overflowText = streamedText.slice(currentMsgOffset);
              if (overflowText.trim()) {
                replyMessage = await message.channel.send(capDiscordText(overflowText));
                lastUpdateAt = Date.now();
              }
              return;
            }

            if (Date.now() - lastUpdateAt >= discordStreamUpdateMs) {
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
      const finalChunks = splitDiscordText(remainingText);

      if (replyMessage) {
        await updateReply(finalChunks[0], true);
      } else {
        replyMessage = await message.reply(capDiscordText(finalChunks[0]));
      }

      for (let i = 1; i < finalChunks.length; i++) {
        try {
          await message.channel.send(finalChunks[i]);
        } catch (sendError) {
          if (!isDiscordTooLong(sendError) || finalChunks[i].length <= 500) {
            throw sendError;
          }
          const mid = Math.floor(finalChunks[i].length / 2);
          await message.channel.send(finalChunks[i].slice(0, mid) || ".");
          if (mid < finalChunks[i].length) {
            finalChunks.splice(i + 1, 0, finalChunks[i].slice(mid));
          }
        }
      }
    } catch (error) {
      console.error("[discord][message] error", error);
      try {
        if (replyMessage) {
          const errorSuffix = "\n\n⚠️ 출력 중 에러가 발생했습니다.";
          let errorText;
          const currentStreamedText = streamedText.slice(currentMsgOffset);
          if (currentStreamedText.trim()) {
            const maxContent = discordMaxLength - errorSuffix.length;
            errorText = currentStreamedText.trim().slice(0, maxContent) + errorSuffix;
          } else {
            errorText = "에러가 발생했습니다. 잠시 후 다시 시도해주세요.";
          }
          try {
            await replyMessage.edit(errorText);
          } catch (editError) {
            if (isDiscordTooLong(editError)) {
              await replyMessage.edit(errorText.slice(0, Math.floor(errorText.length / 2)) || ".");
            }
          }
        } else {
          await message.reply("에러가 발생했습니다. 잠시 후 다시 시도해주세요.");
        }
      } catch (innerError) {
        console.error("[discord][message] error reply failed", innerError);
      }
    } finally {
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      if (addedReaction) {
        try {
          await message.reactions.resolve("👀")?.users.remove(client.user.id);
        } catch (error) {
          console.error("[discord][reaction_remove] skipped", error);
        }
      }
    }
  });

  client.on("error", (error) => {
    console.error("[discord][client_error]", error);
  });

  await client.login(config.botToken);
  console.log(
    `[discord] started name=${config.name} bot_user=${client.user?.id} model=${config.model || "default"} web_search=${config.webSearch} system_prompt=${config.systemPrompt ? "service" : "default"}`
  );

  return {
    async stop() {
      client.destroy();
      console.log(`[discord] stopped name=${config.name}`);
    }
  };
}
