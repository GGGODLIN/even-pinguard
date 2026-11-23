import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinGuardEngine } from "../src/engine/pinguard-engine.js";
import type { IncomingTelegramMessage, TelegramDeliveryPort } from "../src/engine/types.js";
import { createPinGuardServer } from "../src/server/http-server.js";
import { main } from "../src/server/main.js";

const alpha = "-100101";
const beta = "-100102";
const gamma = "-100103";
const delta = "-100104";
const ops = "-100201";
const announce = "-100301";
const admin = "5001";
const guest = "5002";
const seedTime = 1_790_000_000;
const conflictTime = seedTime + 10;
const now = seedTime + 20;
const token = "90210:synthetic-PinGuard-secret";
const draft = "Registration deadline is December 5, 2026 at 17:00.";
const update = "Registration deadline is now December 7, 2026 at 17:00.";
const seed = { factKey: "registration", text: draft, questions: ["When does registration close?"], effectiveAt: seedTime };
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pinguard-db-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "test.sqlite");
  const telegram = {
    sendMessage: vi.fn<TelegramDeliveryPort["sendMessage"]>(async (chatId) => ({ chat: { id: chatId }, message_id: 41 })),
    pinChatMessage: vi.fn<TelegramDeliveryPort["pinChatMessage"]>().mockResolvedValue(true),
  };
  const createEngine = () => new PinGuardEngine({
    dbPath, telegram, communityChatIds: [alpha, beta, gamma, delta], opsChatId: ops, announceChatId: announce,
    adminUserIds: [admin], telegramBotToken: token, now: () => now,
  });
  let engine = createEngine();
  cleanups.push(() => engine.close());
  const restart = () => {
    engine.close();
    engine = createEngine();
    return engine;
  };
  const server = createPinGuardServer(engine, [token]);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string) => fetch(base + path);
  const post = (path: string, body: unknown) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { dir, engine, telegram, restart, get, post };
}

function ingest(engine: PinGuardEngine, overrides: Partial<IncomingTelegramMessage> = {}) {
  engine.ingestMessage({
    chatId: alpha, messageId: 1, fromUserId: guest, timestamp: seedTime + 1,
    text: "WHEN IS THE REGISTRATION DEADLINE?", ...overrides,
  });
}

function ready(engine: PinGuardEngine, groups = [alpha, beta], version = 1) {
  engine.seedFacts(seed);
  for (const chatId of groups) ingest(engine, { chatId });
  const [cluster] = engine.getState().clusters;
  expect(cluster).toMatchObject({ status: "READY", version, fact_key: "registration", draft });
  return { clusterId: cluster.cluster_id, expectedVersion: cluster.version };
}

function conflict(engine: PinGuardEngine, overrides: Partial<IncomingTelegramMessage> = {}) {
  ingest(engine, { chatId: ops, fromUserId: admin, text: update, timestamp: conflictTime, ...overrides });
}

function countPublicSends(telegram: Awaited<ReturnType<typeof fixture>>["telegram"]): number {
  return telegram.sendMessage.mock.calls.filter(([chat]) => chat !== ops).length;
}

it("processes queued updates with poll headroom and drains an in-flight execute on a polling conflict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pinguard-main-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const seedPath = join(dir, "facts.json");
  const dbPath = join(dir, "main.sqlite");
  const sendOpsCard = vi.fn<TelegramDeliveryPort["sendMessage"]>(async (chatId) => ({ chat: { id: chatId }, message_id: 41 }));
  const beforeRestart = new PinGuardEngine({
    dbPath, communityChatIds: [alpha, beta], opsChatId: ops, announceChatId: announce, adminUserIds: [admin],
    telegram: { sendMessage: sendOpsCard, pinChatMessage: async () => true },
  });
  try {
    beforeRestart.seedFacts({ factKey: "capacity", text: "Room A has 80 seats.", effectiveAt: seedTime });
    conflict(beforeRestart, { text: "Room A has 100 seats." });
    await beforeRestart.escalateConflict({ factKey: "capacity", expectedVersion: 2 });
  } finally {
    beforeRestart.close();
  }
  const callbackData = sendOpsCard.mock.calls[0][2]!.reply_markup.inline_keyboard[0][0].callback_data;
  await writeFile(seedPath, JSON.stringify(seed));
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const address = portProbe.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const localFetch = globalThis.fetch;
  const exitCode = process.exitCode;
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listenerCounts = signals.map((signal) => process.listenerCount(signal));
  const pollStarted = Promise.withResolvers<void>();
  const stopPolling = Promise.withResolvers<void>();
  const shutdownStarted = Promise.withResolvers<void>();
  const sendStarted = Promise.withResolvers<void>();
  const releaseSend = Promise.withResolvers<void>();
  const polls: unknown[] = [];
  const answered: string[] = [];
  const pending = [
    { update_id: 101, callback_query: { id: "queued-confirm", from: { id: Number(admin) }, data: callbackData,
      message: { chat: { id: Number(ops) }, message_id: 41 } } },
    ...[alpha, beta].map((chatId, index) => ({ update_id: 102 + index, message: {
      chat: { id: Number(chatId) }, message_id: 1, from: { id: Number(guest) },
      date: conflictTime, text: "When does registration close?",
    } })),
    { update_id: 104, message: { chat: { id: Number(ops) }, message_id: 2, from: { id: Number(admin) },
      date: conflictTime + 2, text: "Room A now has 120 seats." } },
  ];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const logError = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
    if (typeof message === "string" && message.startsWith("409 Conflict:")) shutdownStarted.resolve();
  });
  for (const [key, value] of Object.entries({
    TELEGRAM_BOT_TOKEN: token, ADMIN_USER_IDS: admin, COMMUNITY_CHAT_IDS: `${alpha},${beta}`,
    OPS_CHAT_ID: ops, ANNOUNCE_CHAT_ID: announce, PINGUARD_DB_PATH: dbPath, PINGUARD_SEED_FILE: seedPath,
    PORT: String(address.port),
  })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", async (url: string | URL, request: RequestInit) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(String(request.body ?? "{}"));
    const success = (result: unknown) => Response.json({ ok: true, result });
    switch (method) {
      case "getMe": return success({ id: 90210, username: "pinguard_fixture" });
      case "getChatMember": return success({ status: "administrator", can_pin_messages: true });
      case "answerCallbackQuery":
        answered.push(payload.callback_query_id);
        return success(true);
      case "getUpdates":
        polls.push(payload);
        if (polls.length <= 2) return success(pending);
        pollStarted.resolve();
        await stopPolling.promise;
        return new Response(null, { status: 409 });
      case "sendMessage":
        sendStarted.resolve();
        await releaseSend.promise;
        return success({ chat: { id: Number(payload.chat_id) }, message_id: 41 });
      case "pinChatMessage": return success(true);
      default: throw new Error(`Unexpected Telegram method: ${method}`);
    }
  });

  const running = main();
  try {
    await Promise.race([pollStarted.promise, running.then(() => { throw new Error("Polling exited before the test batch"); })]);
    const state = await (await localFetch(`${base}/api/state`)).json();
    expect(state.facts).toContainEqual(expect.objectContaining({
      fact_key: "capacity", text: "Room A has 100 seats.", lock_state: "HOLD_CONFLICT",
      conflict: expect.objectContaining({ text: "Room A now has 120 seats." }),
    }));
    expect(answered).toEqual(["queued-confirm"]);
    const [cluster] = state.clusters;
    expect(cluster).toMatchObject({ fact_key: "registration", status: "READY", draft });
    expect(polls).toEqual([
      { timeout: 0, limit: 1 },
      { timeout: 10, allowed_updates: ["message", "channel_post", "callback_query"] },
      { timeout: 10, offset: 105, allowed_updates: ["message", "channel_post", "callback_query"] },
    ]);

    const execution = localFetch(`${base}/api/actions/execute`, {
      method: "POST", headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ clusterId: cluster.cluster_id, expectedVersion: cluster.version }),
    });
    await Promise.race([sendStarted.promise, execution.then(() => { throw new Error("Execute returned before attempting delivery"); })]);
    stopPolling.resolve();
    await shutdownStarted.promise;
    releaseSend.resolve();
    const response = await execution;
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.receipts).toMatchObject([
      { chat_id: alpha, message_id: 41, status: "PINNED" },
      { chat_id: beta, message_id: 41, status: "PINNED" },
    ]);
    await running;
    expect(process.exitCode).toBe(1);
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(listenerCounts);
    await expect(localFetch(`${base}/api/state`)).rejects.toThrow("fetch failed");
    const reopened = new PinGuardEngine({
      dbPath, communityChatIds: [alpha, beta], opsChatId: ops, announceChatId: announce, adminUserIds: [admin],
      telegram: { sendMessage: vi.fn(), pinChatMessage: vi.fn() },
    });
    try {
      expect(reopened.getReceipts()).toEqual([alpha, beta].map((chat_id) => ({
        action_id: cluster.cluster_id, chat_id, message_id: 41, status: "PINNED", sent: true, pinned: true, error: null,
      })));
    } finally {
      reopened.close();
    }
  } finally {
    stopPolling.resolve();
    releaseSend.resolve();
    try {
      await running;
    } finally {
      process.exitCode = exitCode;
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      log.mockRestore();
      logError.mockRestore();
    }
  }
});

describe("FAQ seeding and clustering", () => {
  it("waits for three separate matching questions in one group", async () => {
    const { engine, get } = await fixture();
    expect(engine.seedFacts([seed])).toBe(1);
    ingest(engine);
    ingest(engine);
    ingest(engine, { messageId: 2, text: "When does registration close?" });
    ingest(engine, { messageId: 3, text: " " });
    ingest(engine, { messageId: 4, text: undefined });
    ingest(engine, { messageId: 5, isBot: true });
    ingest(engine, { messageId: 6, text: "Registration deadline is on the website." });
    expect(engine.getState().clusters).toEqual([]);
    ingest(engine, { messageId: 7 });
    const response = await get("/api/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      facts: [{ fact_key: "registration", text: draft, revision: 1, effective_at: seedTime, version: 1,
        lock_state: "CLEAR", confirmed: false, conflict: null }],
      clusters: [{ cluster_id: expect.any(String), fact_key: "registration", status: "READY", version: 1,
        lock_state: "CLEAR", confirmed: false, draft, groups: [{ chat_id: alpha, count: 3 }] }],
    });
  });

  it("clusters CJK questions across groups and keeps unseeded chatter idle", async () => {
    const { engine, dir } = await fixture();
    const seedPath = join(dir, "faq-seed.json");
    const text = "報名截止為12月5日 17:00。";
    await writeFile(seedPath, JSON.stringify({ factKey: "signup", text, effectiveAt: seedTime }));
    await expect(engine.loadFaqSeedFile(seedPath)).resolves.toBe(1);
    engine.seedFacts(seed);
    ingest(engine, { text: "What is the catering deadline?" });
    ingest(engine, { chatId: beta, text: "What is the catering deadline?" });
    ingest(engine, { text: "補助截止是何時？" });
    ingest(engine, { chatId: beta, text: "補助截止是何時？" });
    ingest(engine, { messageId: 2, text: "請問報名截止是何時？" });
    ingest(engine, { chatId: announce, text: "請問報名截止是何時？" });
    expect(engine.getState().clusters).toEqual([]);
    ingest(engine, { chatId: beta, messageId: 2, text: "報名截止日是何時？" });
    expect(engine.getState().clusters).toEqual([{
      cluster_id: expect.any(String), fact_key: "signup", status: "READY", version: 1, lock_state: "CLEAR",
      confirmed: false, draft: text, groups: [{ chat_id: alpha, count: 1 }, { chat_id: beta, count: 1 }],
    }]);
  });

  it("seeds from the FAQ file, not Telegram or HTTP, and keeps announce read-only", async () => {
    const { dir, engine, post, telegram } = await fixture();
    const fileSeed = { ...seed, effectiveAt: seedTime + 1 };
    const text = `/seed ${JSON.stringify(fileSeed)}`;
    ingest(engine, { chatId: announce, fromUserId: admin, text });
    ingest(engine, { chatId: ops, fromUserId: guest, text });
    ingest(engine, { fromUserId: admin, text });
    ingest(engine, { chatId: ops, fromUserId: admin, text });
    ingest(engine, { messageId: 2 });
    ingest(engine, { chatId: beta, messageId: 2 });
    expect((await post("/api/seed", [fileSeed])).status).toBe(404);
    expect(engine.getState()).toEqual({ facts: [], clusters: [] });
    const seedPath = join(dir, "faq-seed.json");
    await writeFile(seedPath, JSON.stringify(fileSeed));
    await expect(engine.loadFaqSeedFile(seedPath)).resolves.toBe(1);
    expect(engine.getState().facts).toMatchObject([
      { fact_key: "registration", text: draft, revision: 1, version: 1, effective_at: seedTime + 1 },
    ]);
    const action = ready(engine);
    conflict(engine, { chatId: announce });
    expect(engine.getState().facts).toMatchObject([
      { fact_key: "registration", revision: 1, lock_state: "HOLD_CONFLICT", conflict: { chat_id: announce } },
    ]);
    await expect(engine.executeCluster(action)).rejects.toMatchObject({ status: 409 });
    await engine.escalateConflict({ factKey: "registration", expectedVersion: 2 });
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([ops]);
    expect(telegram.pinChatMessage).not.toHaveBeenCalled();
  });
});

describe("versioned conflict lock", () => {
  it.each([
    ["Confirm New", 0, update],
    ["Keep Original", 1, draft],
  ])("releases the hard lock via %s without re-detecting earlier messages", async (label, index, expectedText) => {
    const { engine, telegram, post, get } = await fixture();
    const action = ready(engine);
    conflict(engine, { fromUserId: guest });
    conflict(engine, { timestamp: seedTime });
    conflict(engine, { timestamp: seedTime + 2, text: draft });
    expect(engine.getState().facts[0]).toMatchObject({ lock_state: "CLEAR", version: 1, conflict: null });
    conflict(engine, { messageId: 9 });

    const locked = await get("/api/state");
    expect(await locked.json()).toMatchObject({
      clusters: [{ cluster_id: action.clusterId, fact_key: "registration", status: "HOLD_CONFLICT", lock_state: "HOLD_CONFLICT", version: 2 }],
      facts: [{ fact_key: "registration", text: draft, revision: 1,
        conflict: { chat_id: ops, message_id: 9, timestamp: conflictTime, text: update } }],
    });
    expect((await post("/api/actions/execute", { ...action, expectedVersion: 2 })).status).toBe(409);
    expect((await post("/api/actions/execute", action)).status).toBe(409);
    expect(countPublicSends(telegram)).toBe(0);

    const escalate = { factKey: "registration", expectedVersion: 2 };
    expect((await post("/api/actions/escalate", { ...escalate, expectedVersion: 1 })).status).toBe(409);
    const response = await post("/api/actions/escalate", escalate);
    expect(response.status).toBe(200);
    expect((await post("/api/actions/escalate", escalate)).status).toBe(409);
    const [, , keyboard] = telegram.sendMessage.mock.calls[0];
    const buttons = keyboard!.reply_markup.inline_keyboard[0];
    expect(buttons.map(({ text }) => text)).toEqual(["Confirm New", "Keep Original"]);
    expect(buttons[index].text).toBe(label);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([ops]);
    expect((await post("/api/actions/execute", { ...action, expectedVersion: 3 })).status).toBe(409);
    expect(countPublicSends(telegram)).toBe(0);

    const data = buttons[index].callback_data;
    const confirm = { fromUserId: admin, chatId: ops };
    const awaiting = engine.getState();
    expect(awaiting.facts[0]).toMatchObject({ revision: 1, version: 3, lock_state: "AWAITING_CONFIRM", confirmed: false });
    expect(() => engine.handleCallbackQuery({ ...confirm, fromUserId: guest, data })).toThrow("authorized ops admins");
    expect(() => engine.handleCallbackQuery({ ...confirm, chatId: announce, data })).toThrow("authorized ops admins");
    expect(() => engine.handleCallbackQuery({ ...confirm, data: `${data}\n` })).toThrow("Invalid conflict callback");
    expect(() => engine.handleCallbackQuery({ ...confirm, data: data.replace(/:3$/, ":2") })).toThrow("Stale fact version");
    expect(engine.getState()).toEqual(awaiting);
    engine.handleCallbackQuery({ ...confirm, data });
    expect(() => engine.handleCallbackQuery({ ...confirm, data })).toThrow("no longer awaiting confirmation");

    conflict(engine, { messageId: 9 });
    conflict(engine, { messageId: 10, timestamp: conflictTime - 1 });
    conflict(engine, { messageId: 11, timestamp: conflictTime });
    expect(engine.getState()).toMatchObject({
      facts: [{ fact_key: "registration", text: expectedText, revision: 2, effective_at: conflictTime, version: 4,
        lock_state: "CLEAR", confirmed: true, conflict: null }],
      clusters: [{ cluster_id: action.clusterId, status: "READY", draft: expectedText, version: 4, confirmed: true }],
    });
    expect((await post("/api/actions/execute", { ...action, expectedVersion: 3 })).status).toBe(409);
    expect(countPublicSends(telegram)).toBe(0);
    const executed = await post("/api/actions/execute", { ...action, expectedVersion: 4 });
    expect(executed.status).toBe(200);
    expect(telegram.sendMessage.mock.calls.slice(1)).toEqual([[alpha, expectedText], [beta, expectedText]]);
    expect(engine.getState().clusters).toEqual([]);
  });

  it("detects a newer admin update received in the same delayed batch as confirmation", async () => {
    const { engine, telegram } = await fixture();
    ready(engine);
    conflict(engine);
    await engine.escalateConflict({ factKey: "registration", expectedVersion: 2 });
    const data = telegram.sendMessage.mock.calls[0][2]!.reply_markup.inline_keyboard[0][0].callback_data;
    engine.handleCallbackQuery({ chatId: ops, fromUserId: admin, data });
    const newer = "Registration deadline is now December 9, 2026 at 17:00.";
    conflict(engine, { messageId: 2, timestamp: conflictTime + 2, text: newer });
    expect(engine.getState().facts[0]).toMatchObject({
      text: update, effective_at: conflictTime, revision: 2, lock_state: "HOLD_CONFLICT", version: 5,
      conflict: { text: newer, timestamp: conflictTime + 2 },
    });
  });

  it("detects room capacity swaps even when all of the numbers still match", async () => {
    const { engine } = await fixture();
    const original = "Room A 80 seats, Room B 120 seats";
    const swapped = "Room A 120 seats, Room B 80 seats";
    engine.seedFacts({ factKey: "capacity", text: original, effectiveAt: seedTime });
    conflict(engine, { text: original });
    expect(engine.getState().facts[0]).toMatchObject({ text: original, lock_state: "CLEAR", version: 1 });
    conflict(engine, { messageId: 2, text: swapped });
    expect(engine.getState().facts[0]).toMatchObject({
      text: original, lock_state: "HOLD_CONFLICT", version: 2, conflict: { text: swapped },
    });
  });

  it("trims every long ops card section within Telegram's 4096-character limit", async () => {
    const { engine, telegram } = await fixture();
    const original = `${draft} ${"🟩".repeat(2_100)}`;
    const proposed = `${update} ${"🟦".repeat(2_100)}`;
    const voiceNote = `Context ${"🟨".repeat(2_100)}`;
    engine.seedFacts({ ...seed, text: original });
    conflict(engine, { text: proposed });
    await engine.escalateConflict({ factKey: "registration", expectedVersion: 2, voiceNote });
    const [chatId, card, keyboard] = telegram.sendMessage.mock.calls[0];
    expect(chatId).toBe(ops);
    expect(card.length).toBeLessThanOrEqual(4_096);
    expect(card.isWellFormed()).toBe(true);
    const [, originalSection, newSection, noteSection] = card.split("\n\n");
    expect(originalSection).toMatch(/^Original: Registration .*🟩\.\.\.$/u);
    expect(newSection).toMatch(/^New: Registration .*🟦\.\.\.$/u);
    expect(noteSection).toMatch(/^Internal note: Context .*🟨\.\.\.$/u);
    expect(keyboard?.reply_markup.inline_keyboard[0].map(({ text }) => text)).toEqual(["Confirm New", "Keep Original"]);
  });

  it("normalizes currency and detects a newer numeric conflict", async () => {
    const { engine } = await fixture();
    engine.seedFacts({ factKey: "ticket-price", text: "Ticket price is USD 1,200.00.", effectiveAt: seedTime });
    conflict(engine, { text: "Ticket price remains $1200." });
    expect(engine.getState().facts[0]).toMatchObject({ fact_key: "ticket-price", lock_state: "CLEAR", version: 1 });
    conflict(engine, { messageId: 2, text: "Ticket price is now $1500." });
    expect(engine.getState().facts[0]).toMatchObject({
      fact_key: "ticket-price", text: "Ticket price is USD 1,200.00.", lock_state: "HOLD_CONFLICT", version: 2,
      conflict: { text: "Ticket price is now $1500.", message_id: 2 },
    });
  });

  it("replaces obsolete conflict buttons when a newer admin message arrives", async () => {
    const { engine, telegram } = await fixture();
    ready(engine);
    conflict(engine);
    await engine.escalateConflict({ factKey: "registration", expectedVersion: 2 });
    const oldButton = telegram.sendMessage.mock.calls[0][2]!.reply_markup.inline_keyboard[0][0];
    const latest = "Registration deadline is December 9, 2026 at 17:00.";
    conflict(engine, { messageId: 2, timestamp: conflictTime + 1, text: latest });
    expect(engine.getState().facts[0]).toMatchObject({ lock_state: "HOLD_CONFLICT", version: 4, conflict: { text: latest } });
    await engine.escalateConflict({ factKey: "registration", expectedVersion: 4 });
    expect(() => engine.handleCallbackQuery({ chatId: ops, fromUserId: admin, data: oldButton.callback_data }))
      .toThrow("no longer awaiting confirmation");
    const currentButton = telegram.sendMessage.mock.calls[1][2]!.reply_markup.inline_keyboard[0][0];
    engine.handleCallbackQuery({ chatId: ops, fromUserId: admin, data: currentButton.callback_data });
    expect(engine.getState().facts[0]).toMatchObject({ lock_state: "CLEAR", version: 6, revision: 2, text: latest });
  });
});

describe("bounded per-group delivery", () => {
  it("rejects a READY draft that leaves no room for the lens action cue", async () => {
    const { engine, post, telegram } = await fixture();
    const oversized = "Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven\nLine eight";
    engine.seedFacts({ ...seed, text: oversized });
    for (const chatId of [alpha, beta]) ingest(engine, { chatId, text: "When does registration close?" });
    const [cluster] = engine.getState().clusters;
    expect(cluster).toMatchObject({ status: "READY", draft: oversized });
    const response = await post("/api/actions/execute", { clusterId: cluster.cluster_id, expectedVersion: cluster.version });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Draft exceeds lens display budget; open companion phone view" });
    expect(engine.getReceipts(cluster.cluster_id)).toEqual([]);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("persists exact outcomes and never repeats an ambiguous send after restart", async () => {
    const { engine, telegram, post, get, restart } = await fixture();
    const action = ready(engine, [alpha, beta, gamma, delta], 3);
    const transportError = `Forbidden at https://api.telegram.org/bot${token}/sendMessage`;
    telegram.sendMessage.mockResolvedValueOnce({ chat: { id: alpha }, message_id: 41 })
      .mockResolvedValueOnce({ chat: { id: beta }, message_id: 42 })
      .mockRejectedValueOnce(Object.assign(new Error(transportError), { error_code: 403 }))
      .mockRejectedValueOnce(Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }));
    telegram.pinChatMessage.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("Pin permission removed"));
    const response = await post("/api/actions/execute", action);
    const expected = [
      { action_id: action.clusterId, chat_id: alpha, message_id: 41, status: "PINNED", sent: true, pinned: true, error: null },
      { action_id: action.clusterId, chat_id: beta, message_id: 42, status: "PIN_FAILED", sent: true, pinned: false, error: "Pin permission removed" },
      { action_id: action.clusterId, chat_id: gamma, message_id: null, status: "SEND_FAILED", sent: false, pinned: false, error: "Forbidden at [REDACTED]" },
      { action_id: action.clusterId, chat_id: delta, message_id: null, status: "SEND_UNKNOWN", sent: false, pinned: false, error: "Timed out" },
    ];
    const leaksToken = (text: string) => text.includes(token) || text.includes(encodeURIComponent(token));
    expect(leaksToken(transportError)).toBe(true);
    for (const res of [response, await get("/debug/receipts")]) {
      expect(res.status).toBe(200);
      const serialized = await res.text();
      expect(leaksToken(serialized), "delivery response exposed bot token").toBe(false);
      expect(JSON.parse(serialized)).toMatchObject({ receipts: expected });
    }
    const receiptResponse = await get("/debug/receipts");
    expect(await receiptResponse.json()).toEqual({ receipts: expected });
    expect(telegram.pinChatMessage.mock.calls).toEqual([
      [alpha, 41, { disable_notification: true }], [beta, 42, { disable_notification: true }],
    ]);
    const [sendA, sendB] = telegram.sendMessage.mock.invocationCallOrder;
    const [pinA, pinB] = telegram.pinChatMessage.mock.invocationCallOrder;
    expect(sendA).toBeLessThan(pinA);
    expect(pinA).toBeLessThan(sendB);
    expect(sendB).toBeLessThan(pinB);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha, beta, gamma, delta]);
    expect((await post("/api/actions/execute", action)).status).toBe(409);
    const reopened = restart();
    expect(reopened.getReceipts(action.clusterId)).toEqual(expected);
    expect(reopened.getState().clusters).toEqual([]);
    await expect(reopened.executeCluster(action)).rejects.toMatchObject({ status: 409 });
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha, beta, gamma, delta]);
  });

  it("rejects a stale execute when the affected group list grows", async () => {
    const { engine, telegram, post } = await fixture();
    const action = ready(engine);
    ingest(engine, { chatId: gamma });
    expect(engine.getState().clusters[0]).toMatchObject({ cluster_id: action.clusterId, status: "READY", version: 2 });
    const payload = { cluster_id: action.clusterId, expected_version: action.expectedVersion };
    expect((await post("/api/actions/execute", payload)).status).toBe(409);
    expect(countPublicSends(telegram)).toBe(0);
    expect((await post("/api/actions/execute", { ...payload, expected_version: 2 })).status).toBe(200);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha, beta, gamma]);
  });

  it("stops unsent groups when a conflict arrives during fan-out and resumes under fresh approval", async () => {
    const { engine, telegram } = await fixture();
    const action = ready(engine);
    const sent = Promise.withResolvers<Awaited<ReturnType<TelegramDeliveryPort["sendMessage"]>>>();
    telegram.sendMessage.mockReturnValueOnce(sent.promise);
    const execution = engine.executeCluster(action);
    await expect(engine.executeCluster(action)).rejects.toMatchObject({ status: 409 });
    expect(countPublicSends(telegram)).toBe(1);
    conflict(engine);
    sent.resolve({ chat: { id: alpha }, message_id: 41 });
    expect((await execution).receipts).toMatchObject([
      { chat_id: alpha, message_id: 41, status: "PIN_FAILED", sent: true, pinned: false },
      { chat_id: beta, message_id: null, status: "PENDING", sent: false, pinned: false },
    ]);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha]);
    await engine.escalateConflict({ factKey: "registration", expectedVersion: 2 });
    const data = telegram.sendMessage.mock.calls[1][2]!.reply_markup.inline_keyboard[0][0].callback_data;
    engine.handleCallbackQuery({ chatId: ops, fromUserId: admin, data });
    expect((await engine.executeCluster({ ...action, expectedVersion: 4 })).receipts).toMatchObject([
      { chat_id: alpha, message_id: 41, status: "PIN_FAILED", pinned: false },
      { chat_id: beta, message_id: 41, status: "PINNED", pinned: true },
    ]);
    expect(telegram.sendMessage.mock.calls.at(-1)).toEqual([beta, update]);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha, ops, beta]);
  });

  it("waits the supplied retry_after for a known rejection and retries once", async () => {
    const { engine, telegram } = await fixture();
    const action = ready(engine);
    let firstAttempt = 0;
    telegram.sendMessage.mockImplementationOnce(async () => {
      firstAttempt = performance.now();
      throw Object.assign(new Error("Too many requests"), {
        error_code: 429, parameters: { retry_after: 0.02 },
      });
    }).mockImplementationOnce(async (chatId) => {
      expect(performance.now() - firstAttempt).toBeGreaterThanOrEqual(18);
      return { chat: { id: chatId }, message_id: 42 };
    });
    expect((await engine.executeCluster(action)).receipts).toMatchObject([
      { chat_id: alpha, message_id: 42, status: "PINNED", pinned: true },
      { chat_id: beta, message_id: 41, status: "PINNED", pinned: true },
    ]);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha, alpha, beta]);
  });

  it("redacts seeded content, conflicts and escalation errors at the HTTP boundary", async () => {
    const { engine, telegram, get, post } = await fixture();
    const secretUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const leaks = (text: string) => text.includes(token) || text.includes(encodeURIComponent(token)) || text.includes(secretUrl);
    expect(leaks(secretUrl) && leaks(encodeURIComponent(token))).toBe(true);
    expect(engine.seedFacts({ ...seed, text: `${draft} ${token}` })).toBe(1);
    ingest(engine);
    ingest(engine, { chatId: beta });
    conflict(engine, { text: `${update} ${encodeURIComponent(token)}` });
    const state = await (await get("/api/state")).text();
    expect(leaks(state), "state exposed bot token").toBe(false);
    expect(JSON.parse(state)).toMatchObject({
      facts: [{ fact_key: "registration", text: `${draft} [REDACTED]`, version: 2, lock_state: "HOLD_CONFLICT",
        conflict: { text: `${update} [REDACTED]`, chat_id: ops, message_id: 1 } }],
      clusters: [{ draft: `${draft} [REDACTED]`, lock_state: "HOLD_CONFLICT", version: 2 }],
    });
    telegram.sendMessage.mockRejectedValueOnce(new Error(`Network error at ${secretUrl}`));
    const payload = { factKey: "registration", expectedVersion: 2 };
    const failed = await post("/api/actions/escalate", payload);
    expect(failed.status).toBe(502);
    const errorBody = await failed.text();
    expect(leaks(errorBody), "action error exposed bot token").toBe(false);
    expect(JSON.parse(errorBody)).toEqual({ error: "Network error at [REDACTED]" });
    expect(engine.getState().facts[0]).toMatchObject({ version: 4, lock_state: "HOLD_CONFLICT", revision: 1 });
    const succeeded = await post("/api/actions/escalate", { ...payload, expectedVersion: 4 });
    expect(succeeded.status).toBe(200);
    expect(countPublicSends(telegram)).toBe(0);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([ops, ops]);
  });
});

describe("interrupted delivery", () => {
  it("reopens an unsent ops escalation after restart and preserves a sent card on the next restart", async () => {
    const { engine, telegram, restart } = await fixture();
    ready(engine);
    conflict(engine);
    telegram.sendMessage.mockReturnValueOnce(new Promise(() => {}));
    void engine.escalateConflict({ factKey: "registration", expectedVersion: 2 });
    const interruptedButton = telegram.sendMessage.mock.calls[0][2]!.reply_markup.inline_keyboard[0][0];
    expect(engine.getState().facts[0]).toMatchObject({ lock_state: "AWAITING_CONFIRM", version: 3 });

    const reopened = restart();
    reopened.recoverInterruptedDeliveries();
    expect(reopened.getState().facts[0]).toMatchObject({ lock_state: "HOLD_CONFLICT", version: 4, conflict: { text: update } });
    expect(() => reopened.handleCallbackQuery({ chatId: ops, fromUserId: admin, data: interruptedButton.callback_data }))
      .toThrow("no longer awaiting confirmation");
    await reopened.escalateConflict({ factKey: "registration", expectedVersion: 4 });

    const reopenedAgain = restart();
    reopenedAgain.recoverInterruptedDeliveries();
    expect(reopenedAgain.getState().facts[0]).toMatchObject({ lock_state: "AWAITING_CONFIRM", version: 5 });
    const sentButton = telegram.sendMessage.mock.calls[1][2]!.reply_markup.inline_keyboard[0][0];
    reopenedAgain.handleCallbackQuery({ chatId: ops, fromUserId: admin, data: sentButton.callback_data });
    expect(reopenedAgain.getState().facts[0]).toMatchObject({ lock_state: "CLEAR", version: 6, text: update });
  });

  it("migrates databases created before ops card delivery was tracked", async () => {
    const { dir, engine, telegram, restart } = await fixture();
    ready(engine);
    conflict(engine);
    await engine.escalateConflict({ factKey: "registration", expectedVersion: 2 });
    const legacy = new DatabaseSync(join(dir, "test.sqlite"));
    try {
      if (legacy.prepare("SELECT 1 FROM pragma_table_info('facts') WHERE name = 'conflict_card_sent'").get()) {
        legacy.exec("ALTER TABLE facts DROP COLUMN conflict_card_sent");
      }
    } finally {
      legacy.close();
    }

    const reopened = restart();
    reopened.recoverInterruptedDeliveries();
    expect(reopened.getState().facts[0]).toMatchObject({ text: draft, lock_state: "HOLD_CONFLICT", version: 4 });
    await reopened.escalateConflict({ factKey: "registration", expectedVersion: 4 });
    const reopenedAgain = restart();
    reopenedAgain.recoverInterruptedDeliveries();
    expect(reopenedAgain.getState().facts[0]).toMatchObject({ lock_state: "AWAITING_CONFIRM", version: 5 });
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([ops, ops]);
  });

  it("recovers an in-flight send as unknown and only dispatches previously unsent groups", async () => {
    const { engine, telegram, restart } = await fixture();
    const action = ready(engine);
    const inFlight = Promise.withResolvers<Awaited<ReturnType<TelegramDeliveryPort["sendMessage"]>>>();
    telegram.sendMessage.mockReturnValueOnce(inFlight.promise);
    void engine.executeCluster(action);
    expect(engine.getReceipts(action.clusterId)).toMatchObject([
      { chat_id: alpha, message_id: null, status: "SEND_IN_FLIGHT" },
      { chat_id: beta, message_id: null, status: "PENDING" },
    ]);
    const reopened = restart();
    reopened.recoverInterruptedDeliveries();
    expect(reopened.getState().clusters[0]).toMatchObject({ cluster_id: action.clusterId, status: "READY" });
    expect((await reopened.executeCluster(action)).receipts).toMatchObject([
      { chat_id: alpha, message_id: null, status: "SEND_UNKNOWN", pinned: false },
      { chat_id: beta, message_id: 41, status: "PINNED", pinned: true },
    ]);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha, beta]);
  });

  it("does not issue a 429 retry if a conflicting message arrives before it", async () => {
    const { engine, telegram } = await fixture();
    const action = ready(engine);
    const firstAttempt = Promise.withResolvers<void>();
    telegram.sendMessage.mockImplementationOnce(async () => {
      firstAttempt.resolve();
      throw Object.assign(new Error("Too many requests"), { status: 429, parameters: { retry_after: 0.02 } });
    });
    const delivery = engine.executeCluster(action);
    await firstAttempt.promise;
    conflict(engine);
    expect((await delivery).receipts).toMatchObject([
      { chat_id: alpha, message_id: null, status: "PENDING", pinned: false },
      { chat_id: beta, message_id: null, status: "PENDING", pinned: false },
    ]);
    expect(telegram.sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([alpha]);
    expect(engine.getState().clusters[0]).toMatchObject({
      cluster_id: action.clusterId, status: "HOLD_CONFLICT", version: 2,
    });
  });
});
