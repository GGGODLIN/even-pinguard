import { Api, HttpError } from "grammy/web";
import type { Config } from "../config.js";
import { redactSecret, sanitizeError } from "../redaction.js";

interface InlineKeyboard {
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
}

interface PollOptions {
  timeout: number;
  limit?: number;
  offset?: number;
  allowed_updates?: ["message", "channel_post", "callback_query"];
}

export interface TelegramUpdateMessage {
  chat: { id: string };
  message_id: number;
  from?: { id: string; is_bot?: boolean };
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramUpdateMessage;
  channel_post?: TelegramUpdateMessage;
  callback_query?: {
    id: string;
    from: { id: string };
    data?: string;
    message?: { chat: { id: string }; message_id: number };
  };
}

export interface TelegramPreflightTransport {
  getMe(): Promise<{ id: string; username: string }>;
  getChatMember(chatId: string, botId: string): Promise<{ status: string; can_pin_messages?: boolean }>;
  sendMessage(chatId: string, text: string, options?: InlineKeyboard): Promise<{
    chat: { id: string };
    message_id: number;
  }>;
  pinChatMessage(chatId: string, messageId: number, options: { disable_notification: true }): Promise<boolean>;
  getUpdates(options: PollOptions, signal?: AbortSignal): Promise<readonly TelegramUpdate[]>;
  answerCallbackQuery(callbackQueryId: string): Promise<boolean>;
}

export function createTelegramTransport(token: string, fetchTelegram = globalThis.fetch): TelegramPreflightTransport {
  const api = new Api(token, {
    timeoutSeconds: 15,
    sensitiveLogs: false,
    baseFetchConfig: { redirect: "error" },
    fetch: async (url: string | URL, init: RequestInit) => {
      const response = await fetchTelegram(url, init);
      if (response.status === 409) {
        // Preserve the conflict even when the host returns no Telegram JSON envelope.
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error("Conflict"), { status: 409 });
      }
      return response;
    },
  });
  return {
    async getMe() {
      const { id, username } = await api.getMe();
      return { id: String(id), username };
    },
    async getChatMember(chatId, botId) {
      return api.getChatMember(chatId, Number(botId));
    },
    async sendMessage(chatId, text, options) {
      const { chat, message_id } = await api.sendMessage(chatId, text, options);
      return { chat: { id: String(chat.id) }, message_id };
    },
    pinChatMessage: (chatId, messageId, options) => api.pinChatMessage(chatId, messageId, options),
    async getUpdates(options, signal) {
      // grammY's web build uses native abort signals, but its declarations re-export Node's polyfill type.
      const updates = await api.getUpdates(options, signal as unknown as Parameters<Api["getUpdates"]>[1]);
      const mapMsg = (msg: { chat: { id: number }; message_id: number; from?: { id: number; is_bot?: boolean }; date: number; text?: string } | undefined): TelegramUpdateMessage | undefined =>
        msg && {
          chat: { id: String(msg.chat.id) },
          message_id: msg.message_id,
          from: msg.from && { id: String(msg.from.id), is_bot: msg.from.is_bot },
          date: msg.date,
          text: msg.text,
        };
      return updates.map(({ update_id, message, channel_post, callback_query: query }) => ({
        update_id,
        message: mapMsg(message),
        channel_post: mapMsg(channel_post),
        callback_query: query && {
          id: query.id,
          from: { id: String(query.from.id) },
          data: query.data,
          message: query.message && {
            chat: { id: String(query.message.chat.id) },
            message_id: query.message.message_id,
          },
        },
      }));
    },
    answerCallbackQuery: (id) => api.answerCallbackQuery(id),
  };
}

export function isPollingConflict(error: unknown): boolean {
  const failure: unknown = error instanceof HttpError ? error.error : error;
  return typeof failure === "object" && failure !== null && (
    ("error_code" in failure && failure.error_code === 409) ||
    ("status" in failure && failure.status === 409)
  );
}

async function telegramCall<T>(
  config: Config,
  context: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const secrets = [config.telegramBotToken];
    throw new Error(`${redactSecret(context, secrets)}: ${sanitizeError(error, secrets)}`);
  }
}

async function poll(
  config: Config,
  transport: TelegramPreflightTransport,
  options: PollOptions,
  signal?: AbortSignal,
): Promise<readonly TelegramUpdate[]> {
  return telegramCall(config, "getUpdates", async () => {
    try {
      return await transport.getUpdates(options, signal);
    } catch (error) {
      if (isPollingConflict(error)) {
        throw new Error("409 Conflict: stop any other bot poller and remove any webhook before starting PinGuard");
      }
      if (signal?.aborted) throw new Error("Timed out waiting for the Gate callback_query");
      throw error;
    }
  });
}

export async function runTelegramPreflight(config: Config, transport: TelegramPreflightTransport) {
  const secrets = [config.telegramBotToken];
  const bot = await telegramCall(config, "getMe", () => transport.getMe());
  const groups = [];
  for (const chatId of [...config.communityChatIds, config.opsChatId]) {
    const safeChatId = redactSecret(chatId, secrets);
    const member = await telegramCall(config, `getChatMember for chat_id ${safeChatId}`, () =>
      transport.getChatMember(chatId, bot.id));
    if (member.status !== "administrator" || member.can_pin_messages !== true) {
      throw new Error(`Bot needs administrator can_pin_messages in chat_id ${safeChatId}`);
    }
    groups.push({ chatId: safeChatId, canPinMessages: true });
  }

  // With no offset or update filter this startup check doesn't acknowledge queued updates.
  await poll(config, transport, { limit: 1, timeout: 0 });
  return { botId: redactSecret(bot.id, secrets), username: redactSecret(bot.username, secrets), groups };
}

const callbackData = "pinguard:gate:ack";

function postProbeMessage(
  config: Config,
  transport: TelegramPreflightTransport,
  chatId: string,
  text: string,
  options?: InlineKeyboard,
) {
  return telegramCall(config, `sendMessage for chat_id ${chatId}`, async () => {
    const { chat, message_id: messageId } = await transport.sendMessage(chatId, text, options);
    if (chat?.id !== chatId || !Number.isSafeInteger(messageId) || messageId < 1) {
      throw new Error("Telegram did not return the target chat and a valid message_id");
    }
    return { chatId: redactSecret(chat.id, [config.telegramBotToken]), messageId };
  });
}

async function waitForCallback(
  config: Config,
  transport: TelegramPreflightTransport,
  messageId: number,
  timeoutSec: number,
) {
  const timeoutMs = timeoutSec * 1000;
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  let offset: number | undefined;
  while (!signal.aborted && performance.now() < deadline) {
    const timeout = Math.min(10, Math.ceil((deadline - performance.now()) / 1000));
    const updates = await poll(config, transport, {
      offset,
      timeout,
      allowed_updates: ["message", "channel_post", "callback_query"],
    }, signal);
    if (signal.aborted || performance.now() >= deadline) break;
    for (const { update_id, callback_query: query } of updates) {
      offset = Math.max(offset ?? 0, update_id + 1);
      if (query?.data !== callbackData || query.message?.chat.id !== config.opsChatId ||
          query.message.message_id !== messageId) continue;

      await telegramCall(config, "answerCallbackQuery", async () => {
        if (await transport.answerCallbackQuery(query.id) !== true) throw new Error("Callback not acknowledged");
      });
      const secrets = [config.telegramBotToken];
      return {
        callbackQueryId: redactSecret(query.id, secrets),
        fromUserId: redactSecret(query.from.id, secrets),
        chatId: redactSecret(config.opsChatId, secrets),
        messageId,
        acknowledged: true,
      };
    }
  }
  throw new Error("Timed out waiting for the Gate callback_query");
}

export async function runLiveGateProbe(
  config: Config,
  transport: TelegramPreflightTransport,
  options: { waitCallbackTimeoutSec?: number } = {},
) {
  const { waitCallbackTimeoutSec } = options;
  if (waitCallbackTimeoutSec !== undefined &&
      (!Number.isInteger(waitCallbackTimeoutSec) || waitCallbackTimeoutSec < 1 || waitCallbackTimeoutSec > 2_147_483)) {
    throw new Error("Callback timeout must be a positive integer in seconds within the Node timer range");
  }
  const [chatId] = config.communityChatIds;
  if (!chatId) throw new Error("Configure a community chat for the Gate probe");
  if (config.communityChatIds.includes(config.announceChatId) || config.opsChatId === config.announceChatId) {
    throw new Error("The announce chat is read-only and cannot be a Gate probe target");
  }

  const preflight = await runTelegramPreflight(config, transport);
  const sent = await postProbeMessage(config, transport, chatId, "PinGuard Gate test message (not a community announcement).");
  await telegramCall(config, `pinChatMessage for chat_id ${chatId}, message_id ${sent.messageId}`, async () => {
    if (await transport.pinChatMessage(chatId, sent.messageId, { disable_notification: true }) !== true) {
      throw new Error("Message not pinned");
    }
  });
  const callbackCard = await postProbeMessage(config, transport, config.opsChatId,
    "PinGuard Gate test: press the button to verify Telegram callbacks.", {
      reply_markup: { inline_keyboard: [[{ text: "Acknowledge Gate test", callback_data: callbackData }]] },
    });
  const callback = waitCallbackTimeoutSec === undefined
    ? null
    : await waitForCallback(config, transport, callbackCard.messageId, waitCallbackTimeoutSec);
  return {
    preflight,
    delivery: { ...sent, pinned: true, disableNotification: true },
    callbackCard,
    callback,
  };
}
