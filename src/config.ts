import { redactSecret } from "./redaction.js";

export interface Config {
  telegramBotToken: string;
  communityChatIds: readonly string[];
  opsChatId: string;
  announceChatId: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(telegramBotToken)) {
    throw new Error("Set TELEGRAM_BOT_TOKEN to a valid BotFather token");
  }

  function readRequired(key: string): string {
    const raw = env[key]?.trim();
    if (!raw) throw new Error(`Set ${key}`);
    return raw;
  }

  const communityChatIds = readRequired("COMMUNITY_CHAT_IDS").split(",").map((id) => id.trim());
  const opsChatId = readRequired("OPS_CHAT_ID");
  const announceChatId = readRequired("ANNOUNCE_CHAT_ID");
  const duplicate = [opsChatId, announceChatId].find((id) => communityChatIds.includes(id));
  if (duplicate !== undefined || opsChatId === announceChatId) {
    const chatId = redactSecret(duplicate ?? opsChatId, [telegramBotToken]);
    throw new Error(`Telegram chat ${chatId} must not be shared between community, ops, and announce`);
  }
  if (new Set(communityChatIds).size !== communityChatIds.length) {
    throw new Error("COMMUNITY_CHAT_IDS must not contain duplicates");
  }

  const portText = env.PORT?.trim() ?? "5173";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  return { telegramBotToken, communityChatIds, opsChatId, announceChatId, port };
}
