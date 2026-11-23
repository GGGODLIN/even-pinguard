import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { PinGuardEngine } from "../engine/pinguard-engine.js";
import { PinGuardError } from "../engine/types.js";
import { redactSecret, sanitizeError } from "../redaction.js";
import { GroqSttAdapter, type SttPort } from "../voice/groq-stt.js";
import { isVoiceWav, maxVoiceWavBytes } from "../voice/wav.js";

function mediaType(req: IncomingMessage): string | undefined {
  return req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
}

async function readVoiceWav(req: IncomingMessage): Promise<Uint8Array> {
  if (Number(req.headers["content-length"]) > maxVoiceWavBytes) {
    throw new PinGuardError(400, "Voice WAV must be at most 10 seconds");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxVoiceWavBytes) throw new PinGuardError(400, "Voice WAV must be at most 10 seconds");
    chunks.push(chunk);
  }
  const wav = Buffer.concat(chunks, size);
  if (!isVoiceWav(wav)) throw new PinGuardError(400, "Expected a mono 16 kHz PCM16 voice WAV");
  return wav;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (mediaType(req) !== "application/json") {
    throw new PinGuardError(415, "Expected application/json");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PinGuardError(400, "Invalid JSON request body");
  }
}

function readAction(input: unknown, target: "clusterId" | "factKey"): { id: string; expectedVersion: number } {
  if (!input || typeof input !== "object") throw new PinGuardError(400, "Expected an action object");
  const payload = input as Record<string, unknown>;
  const wireTarget = target === "clusterId" ? "cluster_id" : "fact_key";
  const id = payload[wireTarget] ?? payload[target];
  const expectedVersion = payload.expected_version ?? payload.expectedVersion;
  if ((wireTarget in payload && target in payload && payload[wireTarget] !== payload[target]) ||
      ("expected_version" in payload && "expectedVersion" in payload && payload.expected_version !== payload.expectedVersion) ||
      typeof id !== "string" || !id.trim() || typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new PinGuardError(400, `Expected ${target} and a positive integer expectedVersion`);
  }
  return { id, expectedVersion };
}

async function readEscalation(req: IncomingMessage, engine: PinGuardEngine, stt: SttPort) {
  if (mediaType(req) !== "audio/wav") {
    const input = await readJson(req);
    const { id: factKey, expectedVersion } = readAction(input, "factKey");
    const voiceNote = (input as { voiceNote?: unknown }).voiceNote;
    if (voiceNote !== undefined && typeof voiceNote !== "string") {
      throw new PinGuardError(400, "Expected voiceNote to be a string");
    }
    return { factKey, expectedVersion, voiceNote };
  }

  const query = new URLSearchParams(req.url?.split("?")[1]);
  const version = query.get("expectedVersion") ?? "";
  const { id: factKey, expectedVersion } = readAction({
    factKey: query.get("factKey"), expectedVersion: /^[1-9]\d*$/.test(version) ? Number(version) : NaN,
  }, "factKey");
  const wav = await readVoiceWav(req);
  // Check before audio leaves the server; the engine rechecks after the asynchronous transcription.
  const fact = engine.getState().facts.find((entry) => entry.fact_key === factKey);
  if (!fact) throw new PinGuardError(404, "Fact not found");
  if (fact.version !== expectedVersion) throw new PinGuardError(409, "Stale fact version");
  if (fact.lock_state !== "HOLD_CONFLICT") throw new PinGuardError(409, "Conflict is not ready for escalation");

  let voiceNote: string | undefined;
  try {
    voiceNote = (await stt.transcribe(wav))?.trim() || undefined;
  } catch {
    // An unavailable transcription must not prevent the structured ops card.
  }
  return { factKey, expectedVersion, voiceNote };
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function createPinGuardServer(
  engine: PinGuardEngine,
  secrets: readonly string[] = [],
  stt?: SttPort,
  staticDir?: string,
) {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const outputSecrets = [...secrets, groqKey ?? "", process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ""];
  const transcriber = stt ?? new GroqSttAdapter(groqKey);
  const resolvedStaticDir = staticDir ? resolve(staticDir) : undefined;

  async function tryServeStatic(res: ServerResponse, rawPath: string): Promise<boolean> {
    if (!resolvedStaticDir) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return false;
    }
    const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const target = resolve(resolvedStaticDir, rel);
    if (target !== resolvedStaticDir && !target.startsWith(`${resolvedStaticDir}${sep}`)) return false;
    try {
      const body = await readFile(target);
      const mime = STATIC_MIME[extname(target)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  function reply(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body, (_key, value: unknown) =>
      typeof value === "string" ? redactSecret(value, outputSecrets) : value);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(json);
  }

  return createServer(async (req, res) => {
    const path = req.url?.split("?")[0];
    try {
      if (req.method === "GET" && path === "/api/state") return reply(res, 200, engine.getState());
      if (req.method === "GET" && path === "/debug/receipts") return reply(res, 200, { receipts: engine.getReceipts() });
      if (req.method === "POST" && path === "/api/actions/execute") {
        // Only forward the action identity and version, never client-supplied text or audio.
        const { id, expectedVersion } = readAction(await readJson(req), "clusterId");
        return reply(res, 200, await engine.executeCluster({ clusterId: id, expectedVersion }));
      }
      if (req.method === "POST" && path === "/api/actions/escalate") {
        const { voiceNote, ...action } = await readEscalation(req, engine, transcriber);
        await engine.escalateConflict({
          ...action, voiceNote: voiceNote === undefined ? undefined : redactSecret(voiceNote, outputSecrets),
        });
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/seed") {
        return reply(res, 200, { inserted: engine.seedFacts(await readJson(req)) });
      }
      if (req.method === "GET" && path && await tryServeStatic(res, path)) return;
      return reply(res, 404, { error: "Route not found" });
    } catch (error) {
      req.resume();
      return error instanceof PinGuardError
        ? reply(res, error.status, { error: sanitizeError(error, outputSecrets) })
        : reply(res, 500, { error: "Internal server error" });
    }
  });
}
