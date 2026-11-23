import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { redactSecret } from "../src/redaction.js";
import {
  createTelegramTransport,
  runLiveGateProbe,
  runTelegramPreflight,
  type TelegramPreflightTransport,
} from "../src/telegram/preflight.js";

const fakeToken = "123456789:SYNTHETIC_FAKE_TOKEN_FOR_TEST_ONLY";
const firstCommunity = "-1000000000001";
const secondCommunity = "-1000000000002";
const opsChat = "-1000000000003";
const announceChat = "-1000000000004";
const callbackUserId = "100000001";
const testEnv = {
  TELEGRAM_BOT_TOKEN: fakeToken,
  COMMUNITY_CHAT_IDS: `${firstCommunity},${secondCommunity}`,
  OPS_CHAT_ID: opsChat,
  ANNOUNCE_CHAT_ID: announceChat,
};
const config = loadConfig(testEnv);

function fakeTransport() {
  return {
    getMe: vi.fn<TelegramPreflightTransport["getMe"]>().mockResolvedValue({ id: "123456789", username: "gate_test_bot" }),
    getChatMember: vi.fn<TelegramPreflightTransport["getChatMember"]>()
      .mockResolvedValue({ status: "administrator", can_pin_messages: true }),
    sendMessage: vi.fn<TelegramPreflightTransport["sendMessage"]>()
      .mockResolvedValueOnce({ chat: { id: firstCommunity }, message_id: 41 })
      .mockResolvedValueOnce({ chat: { id: opsChat }, message_id: 87 }),
    pinChatMessage: vi.fn<TelegramPreflightTransport["pinChatMessage"]>().mockResolvedValue(true),
    getUpdates: vi.fn<TelegramPreflightTransport["getUpdates"]>().mockResolvedValue([]),
    answerCallbackQuery: vi.fn<TelegramPreflightTransport["answerCallbackQuery"]>().mockResolvedValue(true),
  } satisfies TelegramPreflightTransport;
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return `${String(error)}\n${JSON.stringify(error)}`;
  }
  throw new Error("Expected the operation to reject with an Error");
}

function telegramReply(result: unknown): Response {
  return Response.json({ ok: true, result });
}

describe("Telegram startup preflight", () => {
  it("reports concrete bot identity and pin permissions for each community group and ops, not announce", async () => {
    const transport = fakeTransport();
    expect(await runTelegramPreflight(config, transport)).toEqual({
      botId: "123456789",
      username: "gate_test_bot",
      groups: [
        { chatId: firstCommunity, canPinMessages: true },
        { chatId: secondCommunity, canPinMessages: true },
        { chatId: opsChat, canPinMessages: true },
      ],
    });
    expect(transport.getChatMember.mock.calls).toEqual([
      [firstCommunity, "123456789"], [secondCommunity, "123456789"], [opsChat, "123456789"],
    ]);
  });

  it.each([
    { status: "administrator" },
    { status: "administrator", can_pin_messages: false },
    { status: "member", can_pin_messages: true },
  ])("fails explicitly for missing pin authority in the offending ops group (%j)", async (member) => {
    const transport = fakeTransport();
    transport.getChatMember.mockImplementation(async (chatId) => chatId === opsChat
      ? member
      : { status: "administrator", can_pin_messages: true });
    await expect(runTelegramPreflight(config, transport)).rejects.toThrow(`can_pin_messages in chat_id ${opsChat}`);
  });

  it("lets Telegram reject a malformed chat_id and reports the identifier with Telegram's reason", async () => {
    const invalidChat = "invalid-chat-id";
    const invalidConfig = loadConfig({ ...testEnv, COMMUNITY_CHAT_IDS: `${firstCommunity},${invalidChat}` });
    const transport = fakeTransport();
    transport.getChatMember.mockImplementation(async (chatId) => {
      if (chatId === invalidChat) throw Object.assign(new Error("Bad Request: chat not found"), { error_code: 400 });
      return { status: "administrator", can_pin_messages: true };
    });
    await expect(runTelegramPreflight(invalidConfig, transport)).rejects.toThrow(
      `getChatMember for chat_id ${invalidChat}: Bad Request: chat not found`,
    );
  });

  it("fails after one polling attempt on a raw HTTP 409 and makes no probe writes", async () => {
    const methods: string[] = [];
    const transport = createTelegramTransport(fakeToken, async (input) => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
      methods.push(method);
      if (method === "getMe") return telegramReply({ id: 123456789, username: "gate_test_bot" });
      if (method === "getChatMember") return telegramReply({ status: "administrator", can_pin_messages: true });
      if (method === "getUpdates") return new Response("Conflict", { status: 409 });
      throw new Error("Unexpected Telegram method during startup conflict");
    });
    await expect(runLiveGateProbe(config, transport)).rejects.toThrow(/409 Conflict: stop any other bot poller/);
    expect(methods).toEqual(["getMe", "getChatMember", "getChatMember", "getChatMember", "getUpdates"]);
  });
});

describe("live Gate probe", () => {
  it("sends then silently pins one test message, and acknowledges only the new card's callback", async () => {
    const transport = fakeTransport();
    transport.getUpdates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { update_id: 700, callback_query: {
          id: "older-button", from: { id: callbackUserId }, data: "pinguard:gate:ack",
          message: { chat: { id: opsChat }, message_id: 86 },
        } },
      ])
      .mockResolvedValueOnce([
        { update_id: 701, callback_query: {
          id: "gate-button", from: { id: callbackUserId }, data: "pinguard:gate:ack",
          message: { chat: { id: opsChat }, message_id: 87 },
        } },
      ]);

    const receipt = await runLiveGateProbe(config, transport, { waitCallbackTimeoutSec: 5 });

    expect(receipt.delivery).toEqual({ chatId: firstCommunity, messageId: 41, pinned: true, disableNotification: true });
    expect(receipt.callbackCard).toEqual({ chatId: opsChat, messageId: 87 });
    expect(receipt.callback).toEqual({
      callbackQueryId: "gate-button", fromUserId: callbackUserId, chatId: opsChat, messageId: 87, acknowledged: true,
    });
    expect(transport.sendMessage.mock.calls).toEqual([
      [firstCommunity, expect.any(String), undefined],
      [opsChat, expect.any(String), {
        reply_markup: { inline_keyboard: [[{ text: "Acknowledge Gate test", callback_data: "pinguard:gate:ack" }]] },
      }],
    ]);
    expect(transport.pinChatMessage.mock.calls).toEqual([[firstCommunity, 41, { disable_notification: true }]]);
    expect(transport.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(transport.pinChatMessage.mock.invocationCallOrder[0]);
    expect(transport.getUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 701 }), expect.any(AbortSignal));
    expect(transport.answerCallbackQuery.mock.calls).toEqual([["gate-button"]]);
  });

  it("rejects a send result from a different chat instead of pinning it or posting the ops card", async () => {
    const transport = fakeTransport();
    transport.sendMessage.mockReset().mockResolvedValueOnce({ chat: { id: announceChat }, message_id: 41 });
    await expect(runLiveGateProbe(config, transport)).rejects.toThrow(
      `sendMessage for chat_id ${firstCommunity}: Telegram did not return the target chat and a valid message_id`,
    );
    expect(transport.sendMessage.mock.calls).toEqual([[firstCommunity, expect.any(String), undefined]]);
    expect(transport.pinChatMessage).toHaveBeenCalledTimes(0);
  });

  it("does not retry if a Telegram 409 arrives during callback polling after startup", async () => {
    const transport = fakeTransport();
    transport.getUpdates.mockResolvedValueOnce([]).mockRejectedValueOnce(
      Object.assign(new Error("Conflict: terminated by other getUpdates request"), { error_code: 409 }),
    );
    await expect(runLiveGateProbe(config, transport, { waitCallbackTimeoutSec: 5 })).rejects.toThrow(/409 Conflict/);
    expect(transport.getUpdates).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight callback poll at the wait deadline through the real adapter", async () => {
    let pendingPolls = 0;
    let abortedPolls = 0;
    const transport = createTelegramTransport(fakeToken, async (input, init) => {
      const method = new URL(String(input)).pathname.split("/").at(-1);
      if (method === "getMe") return telegramReply({ id: 123456789, username: "gate_test_bot" });
      if (method === "getChatMember") return telegramReply({ status: "administrator", can_pin_messages: true });
      if (method === "sendMessage") {
        const { chat_id } = JSON.parse(String(init?.body));
        return telegramReply({ chat: { id: Number(chat_id) }, message_id: 41 });
      }
      if (method === "pinChatMessage") return telegramReply(true);
      if (method !== "getUpdates") throw new Error("Unexpected Telegram method during callback timeout");
      if (JSON.parse(String(init?.body)).timeout === 0) return telegramReply([]);
      pendingPolls += 1;
      const signal = init?.signal;
      if (!signal) throw new Error("Missing abort signal");
      return new Promise((_, reject) => signal.addEventListener("abort", () => {
        abortedPolls += 1;
        reject(new Error("Poll aborted"));
      }, { once: true }));
    });
    await expect(runLiveGateProbe(config, transport, { waitCallbackTimeoutSec: 1 })).rejects.toThrow(
      "Timed out waiting for the Gate callback_query",
    );
    expect({ pendingPolls, abortedPolls }).toEqual({ pendingPolls: 1, abortedPolls: 1 });
  });
});

describe("Gate redaction", () => {
  const encodedToken = encodeURIComponent(fakeToken);
  const alternateToken = "222222222:SYNTHETIC_DIFFERENT_BOT_TOKEN";
  const shortBotToken = "bot333333:SHORT_TEST";
  const leaks = (text: string) => [fakeToken, encodedToken, alternateToken, shortBotToken]
    .map((token) => text.includes(token));
  const fixtureError = `Network failure at https://api.telegram.org/bot${fakeToken}/getUpdates; got ${encodedToken}, ${alternateToken}, ${shortBotToken}`;

  it("detects secret-bearing input and redacts exact and token-shaped values", () => {
    expect(leaks(fixtureError)).toEqual([true, true, true, true]);
    const redacted = redactSecret(fixtureError, [fakeToken]);
    expect(leaks(redacted)).toEqual([false, false, false, false]);
    expect(redacted.includes("[REDACTED]")).toBe(true);
  });

  it("does not expose transport errors, raw request URLs or causes in a preflight error", async () => {
    const transport = fakeTransport();
    transport.getMe.mockRejectedValue(new Error(fixtureError, { cause: { token: fakeToken } }));
    const message = await rejectedMessage(runTelegramPreflight(config, transport));
    expect(leaks(message)).toEqual([false, false, false, false]);
    expect(message.includes("https://api.telegram.org/")).toBe(false);
    expect(message.includes("getMe: Network failure at [REDACTED]")).toBe(true);
  });

  it("does not expose a Telegram description containing secrets when pinning fails", async () => {
    const transport = fakeTransport();
    transport.pinChatMessage.mockRejectedValue({ error_code: 400, message: fixtureError });
    const message = await rejectedMessage(runLiveGateProbe(config, transport));
    expect(leaks(message)).toEqual([false, false, false, false]);
    expect(message.includes(`pinChatMessage for chat_id ${firstCommunity}, message_id 41`)).toBe(true);
  });

  it("redacts untrusted strings in otherwise successful probe receipts", async () => {
    const transport = fakeTransport();
    transport.getMe.mockResolvedValue({ id: "123456789", username: fakeToken });
    transport.getUpdates.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { update_id: 700, callback_query: {
        id: fakeToken, from: { id: callbackUserId }, data: "pinguard:gate:ack",
        message: { chat: { id: opsChat }, message_id: 87 },
      } },
    ]);
    const receipt = await runLiveGateProbe(config, transport);
    expect(JSON.stringify(receipt).includes(fakeToken)).toBe(false);
    expect(receipt.preflight.username.includes("[REDACTED]")).toBe(true);
    expect(receipt.preflight.botId).toBe("123456789");
    expect(receipt.delivery.messageId).toBe(41);
    expect(receipt.callback).toMatchObject({ callbackQueryId: "[REDACTED]", acknowledged: true });
  });
});
