import { loadConfig } from "../src/config.js";
import { sanitizeError } from "../src/redaction.js";
import { createTelegramTransport, runLiveGateProbe, runTelegramPreflight } from "../src/telegram/preflight.js";

function loadLocalEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw new Error("Could not load the local .env file");
  }
}

async function main(args: readonly string[]): Promise<void> {
  const [mode = "--preflight-only", timeout] = args;
  if (!((mode === "--preflight-only" || mode === "--send-probe") && args.length <= 1) &&
      !(mode === "--wait-callback" && args.length === 2 && /^\d+$/.test(timeout))) {
    throw new Error("Usage: tsx scripts/gate-probe.ts [--preflight-only | --send-probe | --wait-callback <timeoutSec>]");
  }

  loadLocalEnv();
  const config = loadConfig();
  const transport = createTelegramTransport(config.telegramBotToken);
  if (mode === "--wait-callback") {
    console.error("Press 'Acknowledge Gate test' on the new PinGuard message in the test ops chat.");
  }
  const receipt = mode === "--preflight-only"
    ? await runTelegramPreflight(config, transport)
    : await runLiveGateProbe(config, transport, {
      waitCallbackTimeoutSec: mode === "--wait-callback" ? Number(timeout) : undefined,
    });
  console.log(JSON.stringify(receipt, null, 2));
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  console.error(JSON.stringify({ ok: false, error: sanitizeError(error, [token]) }));
  process.exitCode = 1;
});
