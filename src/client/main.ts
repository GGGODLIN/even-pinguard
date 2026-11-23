import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { StateSnapshot } from "../engine/types.js";
import { GlassesController, type PinGuardApiClient } from "../glasses/glasses-controller.js";

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
  async escalateConflict(action) {
    const response = await fetch("/api/actions/escalate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action),
    });
    if (!response.ok) throw new Error(`PinGuard escalation request failed (${response.status})`);
  },
};

async function start(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  const controller = new GlassesController(bridge, api, { pollIntervalMs: 1000 });
  window.addEventListener("beforeunload", () => controller.destroy(), { once: true });
  await controller.start();
}

void start().catch(console.error);
