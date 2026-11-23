import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { PinGuardEngine } from "../engine/pinguard-engine.js";
import { sanitizeError } from "../redaction.js";
import { createTelegramTransport, isPollingConflict, runTelegramPreflight } from "../telegram/preflight.js";
import { GroqSttAdapter } from "../voice/groq-stt.js";
import { createPinGuardServer } from "./http-server.js";

function loadOptionalEnv(): void {
  if (!existsSync(".env")) return;
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseAdminUserIds(raw: string | undefined): string[] {
  const ids = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("Set ADMIN_USER_IDS to at least one authorized Telegram numeric user ID");
  return ids;
}

export async function main(): Promise<void> {
  loadOptionalEnv();
  const config = loadConfig(process.env);
  const adminUserIds = parseAdminUserIds(process.env.ADMIN_USER_IDS);
  const groqKey = process.env.GROQ_API_KEY?.trim() || undefined;
  const secrets = [config.telegramBotToken, groqKey ?? ""];
  const dbPath = process.env.PINGUARD_DB_PATH?.trim() || resolve("pinguard.sqlite");
  const seedPath = process.env.PINGUARD_SEED_FILE?.trim() || resolve("faq-seed.json");
  const staticDir = existsSync(resolve("dist")) ? resolve("dist") : undefined;

  const transport = createTelegramTransport(config.telegramBotToken);
  const preflight = await runTelegramPreflight(config, transport);

  const engine = new PinGuardEngine({
    dbPath,
    telegram: transport,
    communityChatIds: config.communityChatIds,
    opsChatId: config.opsChatId,
    announceChatId: config.announceChatId,
    adminUserIds,
    telegramBotToken: config.telegramBotToken,
  });
  engine.recoverInterruptedDeliveries();
  const seeded = existsSync(seedPath) ? await engine.loadFaqSeedFile(seedPath) : 0;

  const server = createPinGuardServer(engine, secrets, new GroqSttAdapter(groqKey), staticDir);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, "127.0.0.1", () => resolveListen());
  });

  console.log(JSON.stringify({
    event: "pinguard_ready",
    url: `http://127.0.0.1:${config.port}`,
    botId: preflight.botId,
    username: preflight.username,
    seeded,
    staticServed: Boolean(staticDir),
  }));

  const abortController = new AbortController();
  const shutdown = (): void => abortController.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  let offset: number | undefined;
  try {
    while (!abortController.signal.aborted) {
      try {
        const updates = await transport.getUpdates({
          timeout: 10,
          offset,
          allowed_updates: ["message", "channel_post", "callback_query"],
        }, abortController.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          const incoming = update.message ?? update.channel_post;
          if (incoming) {
            engine.ingestMessage({
              chatId: incoming.chat.id,
              messageId: incoming.message_id,
              fromUserId: incoming.from?.id,
              isBot: incoming.from?.is_bot,
              timestamp: incoming.date,
              text: incoming.text,
            });
          }
          if (update.callback_query?.message) {
            const query = update.callback_query;
            try {
              engine.handleCallbackQuery({
                chatId: query.message!.chat.id,
                fromUserId: query.from.id,
                data: query.data,
              });
            } catch (error) {
              console.error(JSON.stringify({ event: "callback_rejected", error: sanitizeError(error, secrets) }));
            } finally {
              await transport.answerCallbackQuery(query.id).catch(() => {});
            }
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) break;
        if (isPollingConflict(error)) {
          console.error("409 Conflict: stop any other bot poller and remove any webhook before starting PinGuard");
          process.exitCode = 1;
          break;
        }
        console.error(JSON.stringify({ event: "poll_error", error: sanitizeError(error, secrets) }));
        await delay(1_500, undefined, { signal: abortController.signal }).catch(() => {});
      }
    }
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    engine.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

if (import.meta.main ?? (process.argv[1] && import.meta.filename === resolve(process.argv[1]))) {
  main().catch((error: unknown) => {
    const secrets = [process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "", process.env.GROQ_API_KEY?.trim() ?? ""];
    console.error(sanitizeError(error, secrets));
    process.exitCode = 1;
  });
}
