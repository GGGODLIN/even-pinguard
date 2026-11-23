import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AudioInputSource, DeviceConnectType, DeviceStatus, StartUpPageCreateResult, evenHubEventFromJson, type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCompanionView } from "../src/client/companion-view.js";
import { PinGuardEngine } from "../src/engine/pinguard-engine.js";
import type { ClusterState, DeliveryReceipt, StateSnapshot, TelegramDeliveryPort } from "../src/engine/types.js";
import { GlassesController, type EvenGlassesBridge, type PinGuardApiClient } from "../src/glasses/glasses-controller.js";
import { redactSecret } from "../src/redaction.js";
import { createPinGuardServer } from "../src/server/http-server.js";
import { encodePcm16ToWav, GroqSttAdapter, type SttPort } from "../src/voice/groq-stt.js";

const groqKey = "gsk_SYNTHETIC_GROQ_TEST_KEY_999";
const botToken = "123456:SYNTHETIC_BOT_TOKEN_999";
const upstreamDetails = `${groqKey} ${botToken}`;
const alpha = "-100101";
const beta = "-100102";
const ops = "-100201";
const admin = "5001";
const seedTime = 1_790_000_000;
const factKey = "registration";
const canonical = 'Registration deadline is December 5, 2026 at 17:00.\nBring your <badge>.';
const update = "Registration deadline is now December 7, 2026 at 17:00.";
const context = "The venue needs two more days.";
const action = { factKey, expectedVersion: 2 };
const voiceUrl = "/api/actions/escalate?factKey=registration&expectedVersion=2";
const samples = Uint8Array.of(1, 255, 2, 254);
const wav = () => encodePcm16ToWav([samples]);
const cleanups: (() => void | Promise<void>)[] = [];

function containsKey(text: string): boolean {
  return text.includes(groqKey) || text.includes(botToken);
}

async function safeJson(response: Response) {
  const text = await response.text();
  expect(containsKey(text), "HTTP output contains synthetic credentials").toBe(false);
  return JSON.parse(text);
}

async function fixture(stt?: SttPort, draft = canonical, staticDir?: string) {
  const telegram = {
    sendMessage: vi.fn<TelegramDeliveryPort["sendMessage"]>(async (chatId) => ({ chat: { id: chatId }, message_id: 41 })),
    pinChatMessage: vi.fn<TelegramDeliveryPort["pinChatMessage"]>().mockResolvedValue(true),
  };
  const engine = new PinGuardEngine({
    dbPath: ":memory:", telegram, communityChatIds: [alpha, beta], opsChatId: ops, announceChatId: "-100301",
    adminUserIds: [admin], telegramBotToken: botToken, now: () => seedTime + 20,
  });
  cleanups.push(() => engine.close());
  engine.seedFacts({ factKey, text: draft, questions: ["When does registration close?"], effectiveAt: seedTime });
  for (const chatId of [alpha, beta]) {
    engine.ingestMessage({ chatId, messageId: 1, timestamp: seedTime + 1, text: "When is the registration deadline?" });
  }
  const server = createPinGuardServer(engine, [botToken, groqKey], stt, staticDir);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    engine, telegram,
    get: (path: string) => fetch(base + path),
    post: (path: string, data: unknown) => fetch(base + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    }),
    upload: (path = voiceUrl, body = wav()) => fetch(base + path, {
      method: "POST", headers: { "content-type": "audio/wav" }, body,
    }),
    conflict: () => engine.ingestMessage({
      chatId: ops, fromUserId: admin, messageId: 7, timestamp: seedTime + 10, text: update,
    }),
  };
}

function expectOpsCard(telegram: Awaited<ReturnType<typeof fixture>>["telegram"], note?: string) {
  expect(containsKey(JSON.stringify(telegram.sendMessage.mock.calls))).toBe(false);
  expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  expect(telegram.sendMessage).toHaveBeenCalledWith(ops,
    `PinGuard conflict for registration\n\nOriginal: ${canonical}\n\nNew: ${update}${note ? `\n\nInternal note: ${note}` : ""}`,
    { reply_markup: { inline_keyboard: [[
      { text: "Confirm New", callback_data: expect.stringMatching(/^confirm_new:[a-f0-9]{24}:3$/) },
      { text: "Keep Original", callback_data: expect.stringMatching(/^keep_original:[a-f0-9]{24}:3$/) },
    ]] } });
  expect(telegram.pinChatMessage).not.toHaveBeenCalled();
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

it("serves static symlinks only when their resolved files stay inside the static root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pinguard-static-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "dist");
  const sibling = join(dir, "dist-sibling");
  await mkdir(root);
  await mkdir(sibling);
  await writeFile(join(root, "index.html"), "Companion UI fixture");
  await writeFile(join(sibling, "example.html"), "Sibling UI fixture");
  await symlink(join(root, "index.html"), join(root, "inside.html"));
  await symlink(join(sibling, "example.html"), join(root, "outside.html"));
  const app = await fixture(undefined, canonical, root);

  const inside = await app.get("/inside.html");
  expect(inside.status).toBe(200);
  expect(await inside.text()).toBe("Companion UI fixture");
  const outside = await app.get("/outside.html");
  expect(outside.status).toBe(404);
  expect(await outside.json()).toEqual({ error: "Route not found" });
});

it("encodes capped little-endian mono PCM without a partial sample", () => {
  const file = Buffer.from(encodePcm16ToWav([samples.subarray(0, 1), samples.subarray(1), Uint8Array.of(9)], 16_000, 2 / 16_000));
  expect(file.toString("ascii", 0, 4)).toBe("RIFF");
  expect(file.readUInt32LE(4)).toBe(40);
  expect(file.toString("ascii", 8, 16)).toBe("WAVEfmt ");
  expect(file.readUInt16LE(22)).toBe(1);
  expect(file.readUInt32LE(24)).toBe(16_000);
  expect(file.readUInt16LE(34)).toBe(16);
  expect(file.toString("ascii", 36, 40)).toBe("data");
  expect(file.readUInt32LE(40)).toBe(4);
  expect([...file.subarray(44)]).toEqual([1, 255, 2, 254]);
  expect(encodePcm16ToWav([Uint8Array.of(9)]).byteLength).toBe(44);
});

it("uploads binary WAV to Groq and attaches the returned internal note to the ops card", async () => {
  const upstream = vi.fn<typeof fetch>(async (_url, request) => {
    expect(new Headers(request?.headers).get("authorization") === `Bearer ${groqKey}`).toBe(true);
    expect(request?.method).toBe("POST");
    const form = request?.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.wav");
    expect(file.type).toBe("audio/wav");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...wav()]);
    return Response.json({ text: ` ${context} ${upstreamDetails} ` });
  });
  const app = await fixture(new GroqSttAdapter(groqKey, { fetch: upstream }));
  app.conflict();
  const response = await app.upload();
  expect(response.status).toBe(200);
  expect(await safeJson(response)).toEqual({ ok: true });
  expect(upstream.mock.calls.map(([url]) => url)).toEqual(["https://api.groq.com/openai/v1/audio/transcriptions"]);
  expectOpsCard(app.telegram, `${context} [REDACTED] [REDACTED]`);
  expect((await safeJson(await app.get("/api/state"))).clusters[0]).toMatchObject({
    fact_key: factKey, status: "AWAITING_CONFIRM", version: 3, draft: canonical,
  });
});

it.each(["missing key", "HTTP 429", "timeout", "network error", "port error"])(
  "still sends the structured card without a voice note on %s", async (mode) => {
    const upstream = vi.fn<typeof fetch>();
    if (mode === "HTTP 429") upstream.mockResolvedValue(new Response(upstreamDetails, { status: 429 }));
    if (mode === "timeout") upstream.mockImplementation(() => new Promise(() => {}));
    if (mode === "network error") upstream.mockRejectedValue(new Error(upstreamDetails));
    const consoleSpies = ["log", "warn", "error"].map((method) =>
      vi.spyOn(console, method as "log" | "warn" | "error").mockImplementation(() => {}));
    const stt: SttPort = mode === "port error"
      ? { transcribe: async () => { throw new Error(upstreamDetails); } }
      : new GroqSttAdapter(mode === "missing key" ? " " : groqKey, { fetch: upstream, timeoutMs: 25 });
    const app = await fixture(stt);
    app.conflict();
    const response = await app.upload();
    expect(response.status).toBe(200);
    expect(await safeJson(response)).toEqual({ ok: true });
    expectOpsCard(app.telegram);
    expect(upstream.mock.calls).toHaveLength(mode === "missing key" || mode === "port error" ? 0 : 1);
    if (mode === "timeout") expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const logs = consoleSpies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    expect(containsKey(upstreamDetails), "synthetic credential matcher control").toBe(true);
    expect(containsKey(logs), "logged synthetic credentials").toBe(false);
  },
);

it("validates WAV length, header and HOLD_CONFLICT version before forwarding any audio", async () => {
  const transcribe = vi.fn<SttPort["transcribe"]>().mockResolvedValue(context);
  const app = await fixture({ transcribe });
  const ready = await app.upload(voiceUrl.replace("Version=2", "Version=1"));
  expect(ready.status).toBe(409);
  expect(await safeJson(ready)).toEqual({ error: "Conflict is not ready for escalation" });
  app.conflict();
  const stale = await app.upload(voiceUrl.replace("Version=2", "Version=1"));
  expect(stale.status).toBe(409);
  expect(await safeJson(stale)).toEqual({ error: "Stale fact version" });
  const wrongFormat = await app.upload(voiceUrl, encodePcm16ToWav([samples], 8_000));
  expect(wrongFormat.status).toBe(400);
  expect(await safeJson(wrongFormat)).toEqual({ error: "Expected a mono 16 kHz PCM16 voice WAV" });
  const pcm = new Uint8Array(320_002);
  const oversized = await app.upload(voiceUrl, encodePcm16ToWav([pcm], 16_000, 11));
  expect(oversized.status).toBe(400);
  expect(await safeJson(oversized)).toEqual({ error: "Voice WAV must be at most 10 seconds" });
  expect(transcribe.mock.calls).toHaveLength(0);
  expect(app.telegram.sendMessage).not.toHaveBeenCalled();

  expect(await safeJson(await app.upload(voiceUrl, encodePcm16ToWav([pcm])))).toEqual({ ok: true });
  expect(transcribe.mock.calls.map(([file]) => file.byteLength)).toEqual([320_044]);
  expectOpsCard(app.telegram, context);
});

it("does not send a second ops card if conflict state advances during transcription", async () => {
  let started!: () => void;
  let finish!: (text: string) => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const transcript = new Promise<string>((resolve) => { finish = resolve; });
  const app = await fixture({ transcribe: () => { started(); return transcript; } });
  app.conflict();
  const upload = app.upload();
  await waiting;
  try {
    expect(await safeJson(await app.post("/api/actions/escalate", action))).toEqual({ ok: true });
  } finally {
    finish(context);
  }
  const stale = await upload;
  expect(stale.status).toBe(409);
  expect(await safeJson(stale)).toEqual({ error: "Stale fact version" });
  expectOpsCard(app.telegram);
});

it("ignores voice, text and draft overrides while executing the canonical revision across groups", async () => {
  const transcribe = vi.fn<SttPort["transcribe"]>().mockResolvedValue(context);
  const app = await fixture({ transcribe });
  const [cluster] = app.engine.getState().clusters;
  const binary = await app.upload(`/api/actions/execute?clusterId=${cluster.cluster_id}&expectedVersion=1`);
  expect(binary.status).toBe(415);
  expect(await safeJson(binary)).toEqual({ error: "Expected application/json" });
  const override = "NOT VERIFIED — DO NOT POST";
  const payload = {
    clusterId: cluster.cluster_id, expectedVersion: 1, voiceNote: override, text: override, draft: override, wav: [...wav()],
  };
  const receipt = await safeJson(await app.post("/api/actions/execute", payload));
  expect(receipt.receipts).toEqual([
    { action_id: cluster.cluster_id, chat_id: alpha, message_id: 41, sent: true, pinned: true, status: "PINNED", error: null },
    { action_id: cluster.cluster_id, chat_id: beta, message_id: 41, sent: true, pinned: true, status: "PINNED", error: null },
  ]);
  const posts = app.telegram.sendMessage.mock.calls.map(([, text]) => text).join("\n");
  expect(JSON.stringify(payload).includes(override)).toBe(true);
  expect(posts.includes(override)).toBe(false);
  expect(app.telegram.sendMessage.mock.calls).toEqual([[alpha, canonical], [beta, canonical]]);
  expect(transcribe.mock.calls).toHaveLength(0);

  app.telegram.sendMessage.mockClear();
  app.telegram.pinChatMessage.mockClear();
  app.conflict();
  expect(await safeJson(await app.upload())).toEqual({ ok: true });
  expect(transcribe.mock.calls.map(([file]) => file.byteLength)).toEqual([48]);
  expectOpsCard(app.telegram, context);
});

it("redacts the Groq key pattern without an explicit secret list", () => {
  const raw = `upstream rejected ${groqKey}`;
  expect(raw.includes(groqKey)).toBe(true);
  const safe = redactSecret(raw, []);
  expect(safe.includes(groqKey)).toBe(false);
  expect(safe).toBe("upstream rejected [REDACTED]");
});

it("redacts Groq and Telegram credentials in API state, receipts and failure responses", async () => {
  const app = await fixture({ transcribe: async () => null }, `${canonical}\n${upstreamDetails}`);
  const state: StateSnapshot = await safeJson(await app.get("/api/state"));
  expect(state.clusters[0]).toMatchObject({ draft: `${canonical}\n[REDACTED] [REDACTED]`, status: "READY" });
  app.telegram.pinChatMessage.mockRejectedValueOnce(new Error(`pin denied ${upstreamDetails}`));
  await safeJson(await app.post("/api/actions/execute", { clusterId: state.clusters[0].cluster_id, expectedVersion: 1 }));
  const reply = await safeJson(await app.get("/debug/receipts"));
  expect(reply.receipts[0]).toMatchObject({ chat_id: alpha, message_id: 41, sent: true, pinned: false,
    status: "PIN_FAILED", error: "pin denied [REDACTED] [REDACTED]" });
  app.conflict();
  app.telegram.sendMessage.mockRejectedValueOnce(new Error(`ops denied ${upstreamDetails}`));
  const rejected = await app.post("/api/actions/escalate", { ...action, voiceNote: context });
  expect(rejected.status).toBe(502);
  expect(await safeJson(rejected)).toEqual({ error: "ops denied [REDACTED] [REDACTED]" });
});

class TestElement {
  readonly ownerDocument = { createElement: (tag: string) => new TestElement(tag) };
  private children: (TestElement | string)[] = [];
  constructor(readonly tag: string) {}
  set textContent(text: string) { this.children = [text]; }
  get textContent(): string { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
  append(...nodes: (TestElement | string)[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: TestElement[]) { this.children = nodes; }
  descendants(tag: string): TestElement[] {
    return this.children.flatMap((child) => typeof child === "string" ? []
      : [...(child.tag === tag ? [child] : []), ...child.descendants(tag)]);
  }
}

it("renders live backend state and per-group receipt fields without markup or credentials", async () => {
  const app = await fixture({ transcribe: async () => null });
  const root = new TestElement("main");
  const draw = async () => {
    const state: StateSnapshot = await safeJson(await app.get("/api/state"));
    const { receipts }: { receipts: DeliveryReceipt[] } = await safeJson(await app.get("/debug/receipts"));
    renderCompanionView(root as unknown as HTMLElement, state, receipts);
    return state;
  };
  expect((await draw()).clusters[0].status).toBe("READY");
  expect(root.descendants("p").map((node) => node.textContent)).toContain(canonical);
  app.conflict();
  await draw();
  expect(root.descendants("strong").map((node) => node.textContent)).toEqual(["HOLD_CONFLICT"]);
  expect(root.descendants("p").map((node) => node.textContent)).toContain(update);
  expect(await safeJson(await app.post("/api/actions/escalate", action))).toEqual({ ok: true });
  await draw();
  expect(root.descendants("strong").map((node) => node.textContent)).toEqual(["AWAITING_CONFIRM"]);
  const keepOriginal = app.telegram.sendMessage.mock.calls[0][2]!.reply_markup.inline_keyboard[0][1].callback_data;
  app.engine.handleCallbackQuery({ chatId: ops, fromUserId: admin, data: keepOriginal });
  const [confirmed] = (await draw()).clusters;
  expect(root.descendants("strong").map((node) => node.textContent)).toEqual(["READY", "CONFIRMED"]);
  expect(root.descendants("p").map((node) => node.textContent)).toContain("Version 4 · CONFIRMED");

  app.telegram.pinChatMessage.mockRejectedValueOnce(new Error(`pin denied <b> ${upstreamDetails}`));
  await safeJson(await app.post("/api/actions/execute", { clusterId: confirmed.cluster_id, expectedVersion: 4 }));
  await draw();
  expect(root.descendants("p").map((node) => node.textContent)).toContain("IDLE — no active cluster");
  const rows = root.descendants("dl");
  expect(rows[0].descendants("dt").map((node) => node.textContent)).toEqual([
    "chat_id", "message_id", "sent", "pinned", "status", "error",
  ]);
  expect(rows.map((row) => row.descendants("dd").map((node) => node.textContent))).toEqual([
    [alpha, "41", "true", "false", "PIN_FAILED", "pin denied <b> [REDACTED] [REDACTED]"],
    [beta, "41", "true", "true", "PINNED", "—"],
  ]);
  expect(root.descendants("b")).toEqual([]);
  expect(root.descendants("badge")).toEqual([]);
  expect(containsKey(root.textContent), "companion shows synthetic credentials").toBe(false);

  renderCompanionView(root as unknown as HTMLElement, { facts: [], clusters: [] }, [
    { action_id: "fixture", chat_id: alpha, message_id: null, sent: false, pinned: false, status: "SEND_FAILED",
      error: `pin denied ${groqKey} ${botToken}` },
  ]);
  expect(containsKey(root.textContent), "renderer accepts a raw provider error").toBe(false);
  expect(root.descendants("dd").map((node) => node.textContent)).toEqual([
    alpha, "—", "false", "false", "SEND_FAILED", "pin denied [REDACTED] [REDACTED]",
  ]);
});

const tap = { sysEvent: { eventSource: 1 } };
const up = { textEvent: { eventType: 1 } };
const double = { sysEvent: { eventType: 3 } };
const foreground = { sysEvent: { eventType: 4 } };
const frame = (pcm = samples, source = AudioInputSource.Glasses) => ({ audioEvent: { audioPcm: pcm, source } });
const readyCluster: ClusterState = {
  cluster_id: "candidate", fact_key: factKey, status: "READY", lock_state: "CLEAR", version: 1,
  confirmed: false, draft: "Registration ends on Saturday.", groups: [],
};
const locked: ClusterState = { ...readyCluster, status: "HOLD_CONFLICT", lock_state: "HOLD_CONFLICT", version: 2 };
const tick = () => vi.advanceTimersByTimeAsync(120);

async function glasses(cluster = locked, onError?: (error: Error) => void) {
  let onEvent: (e: EvenHubEvent) => void = () => {};
  let onDeviceStatus: (status: DeviceStatus) => void = () => {};
  const audioControl = vi.fn<NonNullable<EvenGlassesBridge["audioControl"]>>().mockResolvedValue(true);
  const bridge: EvenGlassesBridge = {
    audioControl,
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: (listener) => { onEvent = listener; return () => { onEvent = () => {}; }; },
    onDeviceStatusChanged: (listener) => { onDeviceStatus = listener; return () => { onDeviceStatus = () => {}; }; },
  };
  const api = {
    getState: async () => ({ facts: [], clusters: [cluster] }),
    escalateConflict: vi.fn<PinGuardApiClient["escalateConflict"]>().mockResolvedValue(undefined),
    executeCluster: vi.fn<PinGuardApiClient["executeCluster"]>().mockResolvedValue(undefined),
  };
  const controller = new GlassesController(bridge, api, { onError });
  const started = controller.start();
  await tick();
  await started;
  return {
    audioControl, api, controller, emit: (e: unknown) => onEvent(e as EvenHubEvent),
    disconnect: () => onDeviceStatus(new DeviceStatus({ sn: "mock", connectType: DeviceConnectType.Disconnected })),
  };
}

describe("G2 scoped voice capture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("records only armed conflict microphone samples, caps the WAV, then closes before upload", async () => {
    const g2 = await glasses();
    g2.emit(frame(Uint8Array.of(99, 99)));
    expect(g2.audioControl).not.toHaveBeenCalled();
    g2.emit(tap);
    await tick();
    expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses]]);
    g2.emit(frame(Uint8Array.of(88, 88), AudioInputSource.Phone));
    g2.emit(evenHubEventFromJson({ type: "audioEvent", data: { audioPcm: [1, 255, 2, 254] } }));
    g2.emit(frame(new Uint8Array(320_000).fill(23)));
    g2.emit(frame(Uint8Array.of(77, 77)));
    g2.api.escalateConflict.mockImplementation(async () => {
      expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses], [false]]);
    });
    g2.emit(up);
    await tick();
    const [sent] = g2.api.escalateConflict.mock.calls.map(([input]) => input);
    expect(sent).toMatchObject(action);
    const uploaded = Buffer.from(sent.wav!);
    expect(uploaded.byteLength).toBe(320_044);
    expect(uploaded.readUInt32LE(40)).toBe(320_000);
    expect([...uploaded.subarray(44, 50)]).toEqual([1, 255, 2, 254, 23, 23]);
    expect(uploaded.at(-1)).toBe(23);
    expect(g2.api.executeCluster).not.toHaveBeenCalled();
    g2.controller.destroy();
  });

  it.each([true, false])("retries a rejected microphone close once (retry succeeds: %s)", async (closesOnRetry) => {
    const onError = vi.fn<(error: Error) => void>();
    const g2 = await glasses(locked, onError);
    g2.audioControl.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(closesOnRetry);
    g2.emit(tap);
    await tick();
    g2.emit(tap);
    await tick();
    expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses], [false], [false]]);
    expect(onError.mock.calls.map(([error]) => error.message)).toEqual(closesOnRetry ? [] : ["Failed to close glasses microphone"]);
    g2.controller.destroy();
  });

  it("stops the microphone after 10 seconds even when PCM frames stop arriving", async () => {
    const g2 = await glasses();
    g2.emit(tap);
    await vi.advanceTimersByTimeAsync(0);
    g2.emit(frame());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses], [false]]);
    g2.emit(frame(Uint8Array.of(99, 99)));
    g2.emit(up);
    await tick();
    expect(g2.api.escalateConflict.mock.calls).toEqual([[{ ...action, wav: wav() }]]);
    g2.controller.destroy();
  });

  it.each(["tap", "double click", "foreground", "disconnect", "version change", "destroy"])(
    "closes and discards armed conflict audio on %s", async (reason) => {
      const g2 = await glasses();
      g2.emit(tap);
      await tick();
      expect(g2.audioControl).toHaveBeenCalledWith(true, AudioInputSource.Glasses);
      g2.emit(frame());
      if (reason === "tap") g2.emit(tap);
      if (reason === "double click") g2.emit(double);
      if (reason === "foreground") g2.emit(foreground);
      if (reason === "disconnect") g2.disconnect();
      if (reason === "version change") void g2.controller.applyState({ facts: [], clusters: [{ ...locked, version: 3 }] });
      if (reason === "destroy") g2.controller.destroy();
      g2.emit(up);
      await tick();
      expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses], [false]]);
      expect(g2.api.escalateConflict).not.toHaveBeenCalled();
      expect(g2.api.executeCluster).not.toHaveBeenCalled();
      g2.controller.destroy();
    },
  );

  it("does not upload if a lifecycle event cancels the arm while mic close is pending", async () => {
    const g2 = await glasses();
    let finishClose!: (success: boolean) => void;
    g2.audioControl.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise((done) => { finishClose = done; }));
    g2.emit(tap);
    await tick();
    g2.emit(frame());
    g2.emit(up);
    await vi.advanceTimersByTimeAsync(0);
    expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses], [false]]);
    expect(g2.api.escalateConflict).not.toHaveBeenCalled();
    g2.emit(foreground);
    finishClose(true);
    await tick();
    expect(g2.api.escalateConflict).not.toHaveBeenCalled();
    g2.controller.destroy();
  });

  it("keeps READY voice-free while allowing a later conflict to arm the same microphone", async () => {
    const g2 = await glasses(readyCluster);
    g2.emit(tap);
    await tick();
    g2.emit(frame());
    g2.emit(up);
    await tick();
    expect(g2.api.executeCluster.mock.calls).toEqual([[{ clusterId: "candidate", expectedVersion: 1 }]]);
    expect(g2.audioControl.mock.calls).toHaveLength(0);
    expect(g2.api.escalateConflict).not.toHaveBeenCalled();

    const changed = g2.controller.applyState({ facts: [], clusters: [locked] });
    await tick();
    await changed;
    g2.emit(tap);
    await tick();
    expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses]]);
    g2.emit(up);
    await tick();
    expect(g2.api.escalateConflict.mock.calls).toEqual([[action]]);
    expect(g2.audioControl.mock.calls).toEqual([[true, AudioInputSource.Glasses], [false]]);
    g2.controller.destroy();
  });
});
