import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PinGuardEngine } from "../engine/pinguard-engine.js";
import { PinGuardError } from "../engine/types.js";
import { sanitizeError } from "../redaction.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
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

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

export function createPinGuardServer(engine: PinGuardEngine, secrets: readonly string[] = []) {
  return createServer(async (req, res) => {
    const path = req.url?.split("?")[0];
    try {
      if (req.method === "GET" && path === "/api/state") return reply(res, 200, engine.getState());
      if (req.method === "GET" && path === "/debug/receipts") return reply(res, 200, { receipts: engine.getReceipts() });
      if (req.method === "POST" && path === "/api/actions/execute") {
        const { id, expectedVersion } = readAction(await readJson(req), "clusterId");
        return reply(res, 200, await engine.executeCluster({ clusterId: id, expectedVersion }));
      }
      if (req.method === "POST" && path === "/api/actions/escalate") {
        const input = await readJson(req);
        const { id, expectedVersion } = readAction(input, "factKey");
        const voiceNote = (input as { voiceNote?: unknown }).voiceNote;
        if (voiceNote !== undefined && typeof voiceNote !== "string") {
          throw new PinGuardError(400, "Expected voiceNote to be a string");
        }
        await engine.escalateConflict({ factKey: id, expectedVersion, voiceNote });
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/seed") {
        return reply(res, 200, { inserted: engine.seedFacts(await readJson(req)) });
      }
      return reply(res, 404, { error: "Route not found" });
    } catch (error) {
      req.resume();
      return error instanceof PinGuardError
        ? reply(res, error.status, { error: sanitizeError(error, secrets) })
        : reply(res, 500, { error: "Internal server error" });
    }
  });
}
