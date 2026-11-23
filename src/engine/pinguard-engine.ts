import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { fitsLens } from "../glasses/card-formatter.js";
import { isQuestion, matchFact, valuesConflict } from "../nlp/matcher.js";
import { sanitizeError } from "../redaction.js";
import { openPinGuardDatabase, selectFacts, transaction, type ClusterRow, type DeliveryRow, type FactRow } from "./db.js";
import {
  PinGuardError,
  type CallbackQueryEvent, type ClusterState, type DeliveryReceipt, type FactSeedItem, type FactState,
  type IncomingTelegramMessage, type StateSnapshot, type TelegramDeliveryPort,
} from "./types.js";

interface EngineOptions {
  dbPath: string;
  telegram: TelegramDeliveryPort;
  communityChatIds: readonly string[];
  opsChatId: string;
  announceChatId: string;
  adminUserIds: readonly string[];
  telegramBotToken?: string;
  now?: () => number;
}

interface QuestionGroup {
  chat_id: string;
  count: number;
  last_message_id: number;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000;
}

function validMessageId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseSeedItems(value: unknown): FactSeedItem[] {
  const items: unknown[] = Array.isArray(value) ? value : [value];
  if (items.length === 0) throw new PinGuardError(400, "Provide at least one seed fact");
  return items.map((item) => {
    if (!item || typeof item !== "object" || !("factKey" in item) || !("text" in item)) {
      throw new PinGuardError(400, "Seed facts require factKey and text");
    }
    const { factKey, text } = item;
    const questions = "questions" in item ? item.questions : undefined;
    const effectiveAt = "effectiveAt" in item ? item.effectiveAt : undefined;
    if (typeof factKey !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(factKey) ||
        typeof text !== "string" || !text.trim() ||
        (questions !== undefined && (!Array.isArray(questions) || questions.some((q) => typeof q !== "string" || !q.trim()))) ||
        (effectiveAt !== undefined && !validTimestamp(effectiveAt))) {
      throw new PinGuardError(400, "Invalid factKey, text, questions, or effectiveAt");
    }
    return { factKey, text: text.trim(), questions, effectiveAt };
  });
}

function telegramErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("error_code" in error && typeof error.error_code === "number") return error.error_code;
  if ("status" in error && typeof error.status === "number") return error.status;
  return undefined;
}

function truncateCardSection(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 3).replace(/[\uD800-\uDBFF]$/u, "").trimEnd();
  return `${prefix}...`;
}

async function withRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (telegramErrorCode(error) !== 429) throw error;
    const parameters = (error as { parameters?: { retry_after?: number } }).parameters;
    const seconds = parameters?.retry_after;
    // A long wait leaves the current request without a dependable completion time.
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 5) throw error;
    await delay(seconds * 1_000);
    return call();
  }
}

export class PinGuardEngine {
  private readonly db: DatabaseSync;
  private readonly communityChatIds: ReadonlySet<string>;
  private readonly adminUserIds: ReadonlySet<string>;
  private readonly secrets: readonly string[];
  private readonly now: () => number;

  constructor(private readonly options: EngineOptions) {
    if (options.opsChatId === options.announceChatId ||
        options.communityChatIds.some((id) => id === options.opsChatId || id === options.announceChatId)) {
      throw new Error("Community, ops, and announce chats must be distinct");
    }
    this.communityChatIds = new Set(options.communityChatIds);
    this.adminUserIds = new Set(options.adminUserIds);
    this.secrets = [options.telegramBotToken ?? ""];
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.db = openPinGuardDatabase(options.dbPath);
  }

  close(): void {
    this.db.close();
  }

  seedFacts(input: unknown, sourceTimestamp = this.now()): number {
    const items = parseSeedItems(input);
    return transaction(this.db, () => {
      let inserted = 0;
      for (const { factKey, text, questions = [], effectiveAt = sourceTimestamp } of items) {
        if (this.safe(factKey) !== factKey) throw new PinGuardError(400, "Invalid factKey");
        const result = this.db.prepare("INSERT INTO facts (fact_key, questions) VALUES (?, ?) ON CONFLICT DO NOTHING")
          .run(factKey, JSON.stringify(questions.map((question) => this.safe(question))));
        if (result.changes === 0) continue;
        this.db.prepare("INSERT INTO fact_revisions (fact_key, revision, text, effective_at) VALUES (?, 1, ?, ?)")
          .run(factKey, this.safe(text), effectiveAt);
        inserted++;
      }
      return inserted;
    });
  }

  async loadFaqSeedFile(path: string): Promise<number> {
    return this.seedFacts(JSON.parse(await readFile(path, "utf8")) as unknown);
  }

  ingestMessage(msg: IncomingTelegramMessage): void {
    const text = msg.text?.trim();
    if (!text || msg.isBot || !validTimestamp(msg.timestamp) || !validMessageId(msg.messageId)) return;
    const inCommunity = this.communityChatIds.has(msg.chatId);
    const inOps = msg.chatId === this.options.opsChatId;
    if (!inCommunity && !inOps && msg.chatId !== this.options.announceChatId) return;
    const authorized = this.adminUserIds.has(msg.fromUserId ?? "");
    const question = inCommunity && isQuestion(text);
    if (!question && !authorized) return;

    transaction(this.db, () => {
      const facts = this.db.prepare(selectFacts).all() as unknown as FactRow[];
      const safeText = this.safe(text);
      const match = matchFact(safeText, facts.map((fact) => ({
        factKey: fact.fact_key,
        text: fact.text,
        questions: JSON.parse(fact.questions) as string[],
      })));
      if (!match) return;
      const fact = facts.find((row) => row.fact_key === match.factKey)!;
      if (authorized && this.detectConflict(fact, msg, safeText)) return;
      if (question && match.questionMatches) this.countQuestion(fact, msg);
    });
  }

  private detectConflict(fact: FactRow, msg: IncomingTelegramMessage, text: string): boolean {
    if (msg.timestamp <= fact.effective_at) return false;
    if (fact.conflict_timestamp !== null && msg.timestamp <= fact.conflict_timestamp) {
      if (msg.timestamp < fact.conflict_timestamp) return false;
      if (fact.conflict_chat_id === msg.chatId && msg.messageId <= fact.conflict_message_id!) return true;
    }
    if (!valuesConflict(fact.text, fact.effective_at, text, msg.timestamp)) return false;
    this.db.prepare(`
      UPDATE facts SET lock_state = 'HOLD_CONFLICT', version = version + 1, confirmed = 0,
        conflict_id = ?, conflict_text = ?, conflict_chat_id = ?, conflict_message_id = ?, conflict_timestamp = ?,
        conflict_card_sent = 0
      WHERE fact_key = ?
    `).run(randomBytes(12).toString("hex"), text, msg.chatId, msg.messageId, msg.timestamp, fact.fact_key);
    return true;
  }

  private countQuestion(fact: FactRow, msg: IncomingTelegramMessage): void {
    const cluster = this.db.prepare("SELECT * FROM clusters WHERE fact_key = ? AND status != 'COMPLETE'")
      .get(fact.fact_key) as unknown as ClusterRow | undefined;
    if (cluster?.status === "EXECUTING") return;
    const groups = cluster ? JSON.parse(cluster.groups_json) as QuestionGroup[] : [];
    const group = groups.find((entry) => entry.chat_id === msg.chatId);
    if (group && msg.messageId <= group.last_message_id) return;
    if (group) {
      group.count++;
      group.last_message_id = msg.messageId;
    } else {
      groups.push({ chat_id: msg.chatId, count: 1, last_message_id: msg.messageId });
    }
    const ready = groups.length >= 2 || groups.some((entry) => entry.count >= 3);
    if (cluster) {
      this.db.prepare("UPDATE clusters SET groups_json = ?, status = ? WHERE cluster_id = ?")
        .run(JSON.stringify(groups), ready ? "READY" : "COLLECTING", cluster.cluster_id);
      if (!group && cluster.status === "READY" && fact.lock_state === "CLEAR") {
        this.db.prepare("UPDATE facts SET version = version + 1 WHERE fact_key = ?").run(fact.fact_key);
      }
    } else {
      this.db.prepare("INSERT INTO clusters (cluster_id, fact_key, status, groups_json) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), fact.fact_key, "COLLECTING", JSON.stringify(groups));
    }
  }

  private safe(text: string): string {
    return sanitizeError(text, this.secrets);
  }

  private fact(key: string): FactRow {
    const fact = this.db.prepare(`${selectFacts} WHERE f.fact_key = ?`).get(key) as unknown as FactRow | undefined;
    if (!fact) throw new PinGuardError(404, "Fact not found");
    return fact;
  }

  private cluster(id: string): ClusterRow {
    const row = this.db.prepare("SELECT * FROM clusters WHERE cluster_id = ?").get(id) as unknown as ClusterRow | undefined;
    if (!row) throw new PinGuardError(404, "Cluster not found");
    return row;
  }

  private checkVersion(fact: FactRow, expectedVersion: number): void {
    if (fact.version !== expectedVersion) throw new PinGuardError(409, "Stale fact version");
  }

  async escalateConflict({ factKey, expectedVersion, voiceNote }: {
    factKey: string;
    expectedVersion: number;
    voiceNote?: string;
  }): Promise<void> {
    const fact = transaction(this.db, () => {
      const row = this.fact(factKey);
      this.checkVersion(row, expectedVersion);
      if (row.lock_state !== "HOLD_CONFLICT" || !row.conflict_id) {
        throw new PinGuardError(409, "Conflict is not ready for escalation");
      }
      this.db.prepare(`
        UPDATE facts SET lock_state = 'AWAITING_CONFIRM', version = version + 1, conflict_card_sent = 0
        WHERE fact_key = ?
      `).run(factKey);
      return row;
    });
    const version = fact.version + 1;
    const note = voiceNote?.trim();
    const title = `PinGuard conflict for ${fact.fact_key}`;
    const sections = [
      { label: "\n\nOriginal: ", text: this.safe(fact.text) },
      { label: "\n\nNew: ", text: this.safe(fact.conflict_text!) },
    ];
    if (note) sections.push({ label: "\n\nInternal note: ", text: this.safe(note) });
    let remaining = 4_096 - title.length - sections.reduce((sum, { label }) => sum + label.length, 0);
    // Short sections leave more room for longer ones without changing the display order.
    sections.toSorted((left, right) => left.text.length - right.text.length).forEach((section, index) => {
      section.text = truncateCardSection(section.text, Math.floor(remaining / (sections.length - index)));
      remaining -= section.text.length;
    });
    const card = title + sections.map(({ label, text }) => label + text).join("");
    try {
      await withRateLimitRetry(async () => {
        this.checkVersion(this.fact(factKey), version);
        const sent = await this.options.telegram.sendMessage(this.options.opsChatId, card, {
          reply_markup: { inline_keyboard: [[
            { text: "Confirm New", callback_data: `confirm_new:${fact.conflict_id}:${version}` },
            { text: "Keep Original", callback_data: `keep_original:${fact.conflict_id}:${version}` },
          ]] },
        });
        this.checkSentMessage(this.options.opsChatId, sent);
        this.db.prepare(`
          UPDATE facts SET conflict_card_sent = 1 WHERE fact_key = ? AND version = ?
        `).run(factKey, version);
      });
    } catch (error) {
      this.db.prepare(`
        UPDATE facts SET lock_state = 'HOLD_CONFLICT', version = version + 1
        WHERE fact_key = ? AND version = ? AND lock_state = 'AWAITING_CONFIRM'
      `).run(factKey, version);
      if (error instanceof PinGuardError) throw error;
      throw new PinGuardError(502, sanitizeError(error, this.secrets));
    }
  }

  handleCallbackQuery({ chatId, fromUserId, data }: CallbackQueryEvent): void {
    if (chatId !== this.options.opsChatId || !this.adminUserIds.has(fromUserId)) {
      throw new PinGuardError(403, "Only authorized ops admins can resolve a conflict");
    }
    const match = /^(confirm_new|keep_original):([a-f0-9]{24}):([1-9]\d{0,15})$/.exec(data ?? "");
    const expectedVersion = Number(match?.[3]);
    if (!match || match[0] !== data || !Number.isSafeInteger(expectedVersion)) {
      throw new PinGuardError(400, "Invalid conflict callback data");
    }
    const [, choice, conflictId] = match;
    transaction(this.db, () => {
      const fact = this.db.prepare(`${selectFacts} WHERE f.conflict_id = ?`).get(conflictId) as unknown as FactRow | undefined;
      if (!fact || fact.lock_state !== "AWAITING_CONFIRM" || fact.conflict_text === null || fact.conflict_timestamp === null) {
        throw new PinGuardError(409, "Conflict is no longer awaiting confirmation");
      }
      this.checkVersion(fact, expectedVersion);
      const revision = fact.revision + 1;
      const effectiveAt = Math.max(fact.effective_at, fact.conflict_timestamp);
      const text = choice === "confirm_new" ? fact.conflict_text : fact.text;
      this.db.prepare("INSERT INTO fact_revisions (fact_key, revision, text, effective_at) VALUES (?, ?, ?, ?)")
        .run(fact.fact_key, revision, text, effectiveAt);
      this.db.prepare(`
        UPDATE facts SET active_revision = ?, version = version + 1, lock_state = 'CLEAR', confirmed = 1,
          conflict_id = NULL, conflict_text = NULL, conflict_chat_id = NULL,
          conflict_message_id = NULL, conflict_timestamp = NULL, conflict_card_sent = 0
        WHERE fact_key = ?
      `).run(revision, fact.fact_key);
    });
  }

  async executeCluster({ clusterId, expectedVersion }: { clusterId: string; expectedVersion: number }): Promise<{
    action_id: string;
    receipts: DeliveryReceipt[];
  }> {
    const { fact, pending } = transaction(this.db, () => {
      const cluster = this.cluster(clusterId);
      const fact = this.fact(cluster.fact_key);
      this.assertReadyToSend(fact.fact_key, expectedVersion);
      if (cluster.status !== "READY") throw new PinGuardError(409, "Cluster is not ready");
      const insert = this.db.prepare(`
        INSERT INTO deliveries (action_id, chat_id, status) VALUES (?, ?, 'PENDING') ON CONFLICT DO NOTHING
      `);
      for (const group of JSON.parse(cluster.groups_json) as QuestionGroup[]) {
        insert.run(clusterId, group.chat_id);
      }
      this.db.prepare("UPDATE clusters SET status = 'EXECUTING' WHERE cluster_id = ?").run(clusterId);
      const pending = this.db.prepare("SELECT chat_id FROM deliveries WHERE action_id = ? AND status = 'PENDING' ORDER BY rowid")
        .all(clusterId) as { chat_id: string }[];
      return { fact, pending };
    });

    try {
      for (const { chat_id: chatId } of pending) {
        const canContinue = await this.deliver(clusterId, chatId, fact, expectedVersion);
        if (!canContinue) break;
      }
    } finally {
      transaction(this.db, () => this.finishExecution(clusterId));
    }
    return { action_id: clusterId, receipts: this.getReceipts(clusterId) };
  }

  private assertReadyToSend(factKey: string, expectedVersion: number): void {
    const fact = this.fact(factKey);
    this.checkVersion(fact, expectedVersion);
    if (fact.lock_state !== "CLEAR") throw new PinGuardError(409, "Public delivery is locked");
    if (!fitsLens(fact.text)) throw new PinGuardError(409, "Draft exceeds lens display budget; open companion phone view");
  }

  private checkSentMessage(chatId: string, message: Awaited<ReturnType<TelegramDeliveryPort["sendMessage"]>>): number {
    if (message?.chat?.id !== chatId || !validMessageId(message.message_id)) {
      throw new Error("Telegram did not return the target chat and a valid message_id");
    }
    return message.message_id;
  }

  private async deliver(actionId: string, chatId: string, fact: FactRow, version: number): Promise<boolean> {
    if (!this.communityChatIds.has(chatId)) {
      this.recordDelivery(actionId, chatId, "SEND_FAILED", null, "Chat is not a configured community target");
      return true;
    }
    let messageId: number;
    try {
      const sent = await withRateLimitRetry(() => {
        this.assertReadyToSend(fact.fact_key, version);
        this.recordDelivery(actionId, chatId, "SEND_IN_FLIGHT", null, null);
        return this.options.telegram.sendMessage(chatId, this.safe(fact.text));
      });
      messageId = this.checkSentMessage(chatId, sent);
    } catch (error) {
      if (error instanceof PinGuardError && error.status === 409) {
        // A previous 429 rejected the post, so this group is still eligible for fresh approval.
        this.recordDelivery(actionId, chatId, "PENDING", null, null);
        return false;
      }
      const code = telegramErrorCode(error);
      const rejected = code !== undefined && code >= 400 && code < 500 && code !== 408;
      this.recordDelivery(actionId, chatId, rejected ? "SEND_FAILED" : "SEND_UNKNOWN", null, sanitizeError(error, this.secrets));
      return true;
    }

    this.recordDelivery(actionId, chatId, "SEND_IN_FLIGHT", messageId, null);
    try {
      await withRateLimitRetry(async () => {
        this.assertReadyToSend(fact.fact_key, version);
        if (!await this.options.telegram.pinChatMessage(chatId, messageId, { disable_notification: true })) {
          throw new Error("Telegram did not pin the message");
        }
      });
      this.recordDelivery(actionId, chatId, "PINNED", messageId, null);
    } catch (error) {
      this.recordDelivery(actionId, chatId, "PIN_FAILED", messageId, sanitizeError(error, this.secrets));
    }
    return true;
  }

  private recordDelivery(actionId: string, chatId: string, status: DeliveryRow["status"], messageId: number | null, error: string | null): void {
    this.db.prepare("UPDATE deliveries SET status = ?, message_id = ?, error = ? WHERE action_id = ? AND chat_id = ?")
      .run(status, messageId, error, actionId, chatId);
  }

  private finishExecution(clusterId: string): void {
    const progress = this.db.prepare("SELECT 1 FROM deliveries WHERE action_id = ? AND status IN ('PENDING', 'SEND_IN_FLIGHT')")
      .get(clusterId);
    this.db.prepare("UPDATE clusters SET status = ? WHERE cluster_id = ?")
      .run(progress ? "READY" : "COMPLETE", clusterId);
  }

  /** Call only at startup of the single writer, before accepting new actions. */
  recoverInterruptedDeliveries(): void {
    transaction(this.db, () => {
      this.db.exec(`
        UPDATE deliveries SET status = CASE WHEN message_id IS NULL THEN 'SEND_UNKNOWN' ELSE 'PIN_FAILED' END,
          error = 'Process interrupted during delivery'
        WHERE status = 'SEND_IN_FLIGHT';
        UPDATE facts SET lock_state = 'HOLD_CONFLICT', version = version + 1
        WHERE lock_state = 'AWAITING_CONFIRM' AND conflict_card_sent = 0;
      `);
      const executing = this.db.prepare("SELECT cluster_id FROM clusters WHERE status = 'EXECUTING'")
        .all() as { cluster_id: string }[];
      for (const { cluster_id } of executing) this.finishExecution(cluster_id);
    });
  }

  getState(): StateSnapshot {
    return transaction(this.db, () => {
      const rows = this.db.prepare(`${selectFacts} ORDER BY f.fact_key`).all() as unknown as FactRow[];
      const facts: FactState[] = rows.map((row) => ({
        fact_key: row.fact_key,
        text: this.safe(row.text),
        revision: row.revision,
        effective_at: row.effective_at,
        version: row.version,
        lock_state: row.lock_state,
        confirmed: row.confirmed === 1,
        conflict: row.conflict_id === null ? null : {
          id: row.conflict_id,
          text: this.safe(row.conflict_text!),
          chat_id: this.safe(row.conflict_chat_id!),
          message_id: row.conflict_message_id!,
          timestamp: row.conflict_timestamp!,
        },
      }));
      const active = this.db.prepare("SELECT * FROM clusters WHERE status IN ('READY', 'EXECUTING') ORDER BY rowid")
        .all() as unknown as (ClusterRow & { status: "READY" | "EXECUTING" })[];
      const factsByKey = new Map(facts.map((fact) => [fact.fact_key, fact]));
      const clusters: ClusterState[] = active.map((row) => {
        const fact = factsByKey.get(row.fact_key)!;
        return {
          cluster_id: row.cluster_id,
          fact_key: row.fact_key,
          status: fact.lock_state === "CLEAR" ? row.status : fact.lock_state,
          lock_state: fact.lock_state,
          version: fact.version,
          confirmed: fact.confirmed,
          draft: fact.text,
          groups: (JSON.parse(row.groups_json) as QuestionGroup[]).map(({ chat_id, count }) => ({
            chat_id: this.safe(chat_id), count,
          })),
        };
      });
      return { facts, clusters };
    });
  }

  getReceipts(actionId?: string): DeliveryReceipt[] {
    const rows = (actionId === undefined
      ? this.db.prepare("SELECT * FROM deliveries ORDER BY rowid").all()
      : this.db.prepare("SELECT * FROM deliveries WHERE action_id = ? ORDER BY rowid").all(actionId)) as unknown as DeliveryRow[];
    return rows.map((row) => ({
      action_id: row.action_id,
      chat_id: this.safe(row.chat_id),
      message_id: row.message_id,
      status: row.status,
      sent: row.message_id !== null,
      pinned: row.status === "PINNED",
      error: row.error === null ? null : this.safe(row.error),
    }));
  }
}
