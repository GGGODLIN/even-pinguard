import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { DeliveryReceipt, StateSnapshot } from "../engine/types.js";
import { GlassesController, type PinGuardApiClient } from "../glasses/glasses-controller.js";
import { renderCompanionView } from "./companion-view.js";

const api: PinGuardApiClient = {
  async getState() {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`PinGuard state request failed (${response.status})`);
    return response.json() as Promise<StateSnapshot>;
  },
  async executeCluster(action) {
    const response = await fetch("/api/actions/execute", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action),
    });
    if (!response.ok) throw new Error(`PinGuard execute request failed (${response.status})`);
  },
  async escalateConflict({ factKey, expectedVersion, wav }) {
    const path = "/api/actions/escalate";
    const query = new URLSearchParams({ factKey, expectedVersion: String(expectedVersion) });
    const response = await fetch(wav ? `${path}?${query}` : path, {
      method: "POST", headers: { "content-type": wav ? "audio/wav" : "application/json" },
      body: wav ?? JSON.stringify({ factKey, expectedVersion }),
    });
    if (!response.ok) throw new Error(`PinGuard escalation request failed (${response.status})`);
  },
};

async function getReceipts(): Promise<DeliveryReceipt[]> {
  const response = await fetch("/debug/receipts", { cache: "no-store" });
  if (!response.ok) throw new Error(`PinGuard receipts request failed (${response.status})`);
  const { receipts } = await response.json() as { receipts: DeliveryReceipt[] };
  return receipts;
}

function startCompanion(root: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastRender: string | undefined;
  window.addEventListener("beforeunload", () => {
    stopped = true;
    clearTimeout(timer);
  }, { once: true });

  async function refresh(): Promise<void> {
    try {
      const [state, receipts] = await Promise.all([api.getState(), getReceipts()]);
      if (stopped) return;
      const snapshot = JSON.stringify([state, receipts]);
      if (snapshot !== lastRender) {
        renderCompanionView(root, state, receipts);
        lastRender = snapshot;
      }
    } catch {
      // Keep the last snapshot until the backend responds again.
    } finally {
      if (!stopped) timer = setTimeout(() => void refresh(), 1_000);
    }
  }
  void refresh();
}

async function startGlasses(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  const controller = new GlassesController(bridge, api, { pollIntervalMs: 1000 });
  window.addEventListener("beforeunload", () => controller.destroy(), { once: true });
  await controller.start();
}

const companion = document.getElementById("companion");
if (companion) startCompanion(companion);
void startGlasses().catch(() => console.error("PinGuard glasses startup failed"));
