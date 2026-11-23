import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinGuardEngine } from "../src/engine/pinguard-engine.js";
import type { IncomingTelegramMessage, TelegramDeliveryPort } from "../src/engine/types.js";
import { createPinGuardServer } from "../src/server/http-server.js";

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

describe("FAQ seeding and clustering", () => {
  it("waits for three separate matching questions in one group", async () => {
    const { engine, get, post } = await fixture();
    const seeded = await post("/api/seed", [seed]);
    expect(await seeded.json()).toEqual({ inserted: 1 });
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

  it("honors authorized ops /seed, and never seeds or writes back to announce", async () => {
    const { engine, telegram } = await fixture();
    const text = `/seed ${JSON.stringify({ ...seed, effectiveAt: undefined })}`;
    ingest(engine, { chatId: announce, fromUserId: admin, text });
    ingest(engine, { chatId: ops, fromUserId: guest, text });
    ingest(engine, { fromUserId: admin, text });
    ingest(engine, { messageId: 2 });
    ingest(engine, { chatId: beta, messageId: 2 });
    expect(engine.getState()).toEqual({ facts: [], clusters: [] });
    ingest(engine, { chatId: ops, fromUserId: admin, text });
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
    conflict(engine, { messageId: 10, timestamp: now });
    expect(engine.getState()).toMatchObject({
      facts: [{ fact_key: "registration", text: expectedText, revision: 2, effective_at: now, version: 4,
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
    expect((await post("/api/seed", { ...seed, text: `${draft} ${token}` })).status).toBe(200);
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
