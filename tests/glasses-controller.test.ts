import {
  DeviceConnectType,
  DeviceStatus,
  StartUpPageCreateResult,
  evenHubEventFromJson,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterState, StateSnapshot } from "../src/engine/types.js";
import { SerialBridgeScheduler } from "../src/glasses/bridge-scheduler.js";
import { GlassesController, type EvenGlassesBridge, type PinGuardApiClient } from "../src/glasses/glasses-controller.js";

const draft = "Registration closes December 5, 2026 at 17:00.\n請提早報名。";
const readyText = `READY: TAP TO ARM\n${draft}`;
const armedText = `SWIPE UP: SEND + PIN\n${draft}`;
const idleText = "Idle — no action needed";
const payload = { clusterId: "cluster-1", expectedVersion: 7 };
const tap = { sysEvent: { eventSource: 1 } };
const up = { textEvent: { containerID: 1, containerName: "startup", eventType: 1 } };
const down = { textEvent: { containerID: 1, containerName: "startup", eventType: 2 } };
const foreground = { sysEvent: { eventType: 4 } };

function active(overrides: Partial<ClusterState> = {}): ClusterState {
  return {
    cluster_id: "cluster-1", fact_key: "registration", status: "READY", lock_state: "CLEAR", version: 7,
    confirmed: false, draft, groups: [{ chat_id: "-100101", count: 3 }], ...overrides,
  };
}

function snapshot(...clusters: ClusterState[]): StateSnapshot {
  return { clusters, facts: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function advance(ms = 120) {
  return vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture(initial = snapshot(active()), pollIntervalMs?: number) {
  let backend = initial;
  let lensText: string | undefined;
  let onEvent: ((event: EvenHubEvent) => void) | undefined;
  let onStatus: ((status: DeviceStatus) => void) | undefined;
  const stopEvents = vi.fn(() => { onEvent = undefined; });
  const stopStatus = vi.fn(() => { onStatus = undefined; });
  const bridge = {
    createStartUpPageContainer: vi.fn<EvenGlassesBridge["createStartUpPageContainer"]>(async (page) => {
      lensText = page.textObject?.[0].content;
      return StartUpPageCreateResult.success;
    }),
    textContainerUpgrade: vi.fn<EvenGlassesBridge["textContainerUpgrade"]>(async (update) => {
      lensText = update.content;
      return true;
    }),
    shutDownPageContainer: vi.fn<EvenGlassesBridge["shutDownPageContainer"]>().mockResolvedValue(true),
    onEvenHubEvent: vi.fn<EvenGlassesBridge["onEvenHubEvent"]>((listener) => {
      onEvent = listener;
      return stopEvents;
    }),
    onDeviceStatusChanged: vi.fn<EvenGlassesBridge["onDeviceStatusChanged"]>((listener) => {
      onStatus = listener;
      return stopStatus;
    }),
  };
  const api = {
    getState: vi.fn<PinGuardApiClient["getState"]>(async () => backend),
    executeCluster: vi.fn<PinGuardApiClient["executeCluster"]>().mockResolvedValue(undefined),
    escalateConflict: vi.fn<PinGuardApiClient["escalateConflict"]>().mockResolvedValue(undefined),
  };
  const controller = new GlassesController(bridge, api, { pollIntervalMs });
  return {
    api, bridge, controller, stopEvents, stopStatus,
    lens: () => lensText,
    setBackend: (next: StateSnapshot) => { backend = next; },
    emit: (event: unknown) => onEvent?.(event as EvenHubEvent),
    disconnect: () => onStatus?.(new DeviceStatus({ sn: "mock", connectType: DeviceConnectType.Disconnected })),
    async start() {
      const started = controller.start();
      await advance();
      await started;
    },
    async push(...clusters: ClusterState[]) {
      const applied = controller.applyState(snapshot(...clusters));
      await advance();
      await applied;
    },
  };
}

describe("GlassesController through the SDK and backend boundaries", () => {
  it("starts with one full-lens capture container and shows only idle when backend has no cluster", async () => {
    const glasses = fixture(snapshot());
    await glasses.start();
    expect(glasses.bridge.createStartUpPageContainer).toHaveBeenCalledWith(expect.objectContaining({
      containerTotalNum: 1,
      textObject: [expect.objectContaining({ width: 576, height: 288, isEventCapture: 1, content: idleText })],
    }));
    expect(glasses.lens()).toBe(idleText);
    expect(glasses.api.getState).toHaveBeenCalledTimes(1);
    await glasses.push(active());
    expect(glasses.lens()).toBe(readyText);
  });

  it("only executes after tap then swipe, posts the version shown, and clears the completed card", async () => {
    const glasses = fixture();
    await glasses.start();
    expect(glasses.lens()).toBe(readyText);
    glasses.emit(up);
    await advance();
    expect(glasses.api.getState).toHaveBeenCalledTimes(1);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();
    expect(glasses.api.escalateConflict).not.toHaveBeenCalled();

    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe(armedText);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();

    const pending = deferred<void>();
    glasses.api.executeCluster.mockReturnValueOnce(pending.promise);
    glasses.emit(up);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[payload]]);
    glasses.setBackend(snapshot());
    pending.resolve(undefined);
    await advance();
    expect(glasses.api.getState).toHaveBeenCalledTimes(2);
    expect(glasses.lens()).toBe(idleText);
  });

  it.each([["tap", tap], ["swipe down", down]])("disarms on %s without dispatch", async (_label, cancel) => {
    const glasses = fixture();
    await glasses.start();
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe(armedText);
    glasses.emit(cancel);
    glasses.emit(up);
    await advance();
    expect(glasses.lens()).toBe(readyText);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();

    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[payload]]);
  });

  it("only escalates to ops in conflict, even when the draft contains public action words", async () => {
    const glasses = fixture();
    const publicCue = /SEND|PIN/;
    await glasses.start();
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toMatch(publicCue);
    await glasses.push(active({ status: "HOLD_CONFLICT", lock_state: "HOLD_CONFLICT", version: 8, draft: "SEND and PIN this" }));
    expect(glasses.lens()).toBe("CONFLICT HOLD\nTAP: PREP OPS CARD");
    expect(glasses.lens()).not.toMatch(publicCue);
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe("CONFLICT HOLD\nSWIPE UP: ESCALATE OPS\nTAP / SWIPE DOWN: CANCEL");
    expect(glasses.lens()).not.toMatch(publicCue);
    glasses.setBackend(snapshot(active({ status: "AWAITING_CONFIRM", lock_state: "AWAITING_CONFIRM", version: 9 })));
    glasses.emit(up);
    await advance();
    expect(glasses.api.escalateConflict.mock.calls).toEqual([[{ factKey: "registration", expectedVersion: 8 }]]);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();
    expect(glasses.lens()).toBe("CONFLICT HOLD\nAWAITING OPS CONFIRM");
    expect(glasses.lens()).not.toMatch(publicCue);
    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.escalateConflict).toHaveBeenCalledTimes(1);

    await glasses.push(active({ version: 10 }));
    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster).toHaveBeenCalledWith({ clusterId: "cluster-1", expectedVersion: 10 });
  });

  it.each([
    ["system", { sysEvent: { eventType: 3 } }, { sysEvent: { eventType: 7 } }],
    ["text", { textEvent: { eventType: 3 } }, { sysEvent: { eventType: 6 } }],
  ])("routes %s double-click to shutdown, but only unsubscribes on a later exit", async (_kind, double, exit) => {
    const glasses = fixture();
    await glasses.start();
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe(armedText);
    glasses.emit(double);
    glasses.emit(up);
    await advance();
    expect(glasses.bridge.shutDownPageContainer.mock.calls).toEqual([[1]]);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();
    expect(glasses.api.escalateConflict).not.toHaveBeenCalled();
    expect(glasses.stopEvents).not.toHaveBeenCalled();
    expect(glasses.stopStatus).not.toHaveBeenCalled();
    expect(glasses.lens()).toBe(readyText);

    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[payload]]);
    glasses.emit(exit);
    glasses.emit(double);
    await advance();
    expect(glasses.stopEvents).toHaveBeenCalledTimes(1);
    expect(glasses.stopStatus).toHaveBeenCalledTimes(1);
    expect(glasses.bridge.shutDownPageContainer.mock.calls).toEqual([[1]]);
  });

  it("applies live poll updates, and stops polling and listening on destroy", async () => {
    const glasses = fixture(snapshot(active()), 1000);
    await glasses.start();
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe(armedText);
    glasses.setBackend(snapshot(active({ version: 8, draft: "Doors open at noon." })));
    await advance(1000);
    expect(glasses.api.getState).toHaveBeenCalledTimes(2);
    expect(glasses.lens()).toBe("READY: TAP TO ARM\nDoors open at noon.");
    glasses.emit(up);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();
    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[{ clusterId: "cluster-1", expectedVersion: 8 }]]);
    glasses.controller.destroy();
    glasses.controller.destroy();
    glasses.emit({ sysEvent: { eventType: 3 } });
    await advance(1000);
    expect(glasses.api.getState).toHaveBeenCalledTimes(3);
    expect(glasses.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(glasses.stopEvents).toHaveBeenCalledTimes(1);
    expect(glasses.stopStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "version", next: [active({ version: 8, confirmed: true, draft: "Registration closes at 18:00." })],
      text: "READY: TAP TO ARM [CONFIRMED]\nRegistration closes at 18:00.",
      post: { clusterId: "cluster-1", expectedVersion: 8 } },
    { label: "lock", next: [active({ status: "HOLD_CONFLICT", lock_state: "HOLD_CONFLICT" })],
      text: "CONFLICT HOLD\nTAP: PREP OPS CARD", post: { factKey: "registration", expectedVersion: 7 } },
    { label: "cluster", next: [active({ cluster_id: "cluster-2" })], text: readyText,
      post: { clusterId: "cluster-2", expectedVersion: 7 } },
    { label: "completion", next: [], text: idleText, post: payload },
  ])("disarms synchronously on backend $label changes", async ({ next, text, post }) => {
    const glasses = fixture();
    await glasses.start();
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe(armedText);
    const changed = glasses.push(...next);
    glasses.emit(up);
    await changed;
    expect(glasses.lens()).toBe(text);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();
    expect(glasses.api.escalateConflict).not.toHaveBeenCalled();

    if (next.length === 0) await glasses.push(active());
    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    const action = "factKey" in post ? glasses.api.escalateConflict : glasses.api.executeCluster;
    expect(action.mock.calls).toEqual([[post]]);
  });

  it.each(["foreground", "disconnect"])("clears armed state immediately on %s and rehydrates", async (source) => {
    const glasses = fixture();
    await glasses.start();
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe(armedText);

    const restore = deferred<StateSnapshot>();
    glasses.api.getState.mockReturnValueOnce(restore.promise);
    if (source === "foreground") glasses.emit(foreground);
    else glasses.disconnect();
    glasses.emit(up);
    expect(glasses.api.getState).toHaveBeenCalledTimes(2);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();
    await advance();
    expect(glasses.lens()).toBe(idleText);

    const fresh = snapshot(active({ version: 11, confirmed: true, draft: "Doors open at noon." }));
    glasses.setBackend(fresh);
    restore.resolve(fresh);
    await advance();
    expect(glasses.lens()).toBe("READY: TAP TO ARM [CONFIRMED]\nDoors open at noon.");
    glasses.emit(up);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();
    glasses.emit(tap);
    await advance();
    expect(glasses.lens()).toBe("SWIPE UP: SEND + PIN [CONFIRMED]\nDoors open at noon.");
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[{ clusterId: "cluster-1", expectedVersion: 11 }]]);
  });

  it("does not let an older read overwrite a snapshot pushed during restore", async () => {
    const glasses = fixture();
    await glasses.start();
    const stale = deferred<StateSnapshot>();
    glasses.api.getState.mockReturnValueOnce(stale.promise);
    glasses.emit(foreground);
    expect(glasses.api.getState).toHaveBeenCalledTimes(2);
    await glasses.push(active({ version: 8, draft: "Doors open at noon." }));
    stale.resolve(snapshot(active()));
    await advance();
    expect(glasses.lens()).toBe("READY: TAP TO ARM\nDoors open at noon.");
    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[{ clusterId: "cluster-1", expectedVersion: 8 }]]);
  });

  it.each([
    { limit: "columns", draft: "字".repeat(17) },
    { limit: "rows", draft: "First\nSecond\nThird\nFourth\nFifth\nSixth\nSeventh\nEighth" },
  ])(
    "refuses a draft that exceeds the single-screen budget ($limit)",
    async ({ draft: tooLong }) => {
      const glasses = fixture(snapshot(active({ draft: tooLong })));
      await glasses.start();
      expect(glasses.lens()).toBe("LONG DRAFT -> OPEN PHONE");
      glasses.emit(tap);
      glasses.emit(up);
      await advance();
      expect(glasses.lens()).toBe("LONG DRAFT -> OPEN PHONE");
      expect(glasses.api.getState).toHaveBeenCalledTimes(1);
      expect(glasses.api.executeCluster).not.toHaveBeenCalled();
      await glasses.push(active());
      expect(glasses.lens()).toBe(readyText);
      glasses.emit(tap);
      glasses.emit(up);
      await advance();
      expect(glasses.api.executeCluster.mock.calls).toEqual([[payload]]);
    },
  );

  it("ignores missing enum types outside system events and doesn't mistake unknown system enums for tap", async () => {
    const glasses = fixture();
    await glasses.start();
    for (const event of [
      {}, null, { sysEvent: null }, { sysEvent: [] }, { textEvent: { containerID: 1 } }, { listEvent: {} },
      { textEvent: { eventType: 0 } }, { sysEvent: { eventType: null } }, { sysEvent: { eventType: 99 } },
      evenHubEventFromJson({ type: "sysEvent", data: { eventSource: 1, Event_Type: 99 } }),
    ]) {
      glasses.emit(event);
      glasses.emit(up);
    }
    await advance();
    expect(glasses.lens()).toBe(readyText);
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();

    glasses.emit({ sysEvent: { eventType: 0 } });
    await advance();
    expect(glasses.lens()).toBe(armedText);
    glasses.emit({ sysEvent: { eventType: 1 } });
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[payload]]);
  });

  it("does not authorize from a failed text upgrade and retries the identical card", async () => {
    const glasses = fixture();
    glasses.bridge.textContainerUpgrade.mockResolvedValueOnce(false);
    await glasses.start();
    expect(glasses.bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ content: readyText }));
    expect(glasses.lens()).toBe(idleText);
    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster).not.toHaveBeenCalled();

    await glasses.push(active());
    const attempts = glasses.bridge.textContainerUpgrade.mock.calls.map(([update]) => update.content);
    expect(attempts).toEqual([readyText, readyText]);
    expect(glasses.lens()).toBe(readyText);
    glasses.emit(tap);
    glasses.emit(up);
    await advance();
    expect(glasses.api.executeCluster.mock.calls).toEqual([[payload]]);
  });
});

it("coalesces text updates, and awaits creation, updates, and shutdown without overlap", async () => {
  const { bridge } = fixture();
  const createDone = deferred<StartUpPageCreateResult>();
  const writeDone = deferred<boolean>();
  const shutdownDone = deferred<boolean>();
  const calls: string[] = [];
  bridge.createStartUpPageContainer.mockImplementation(async (page) => {
    calls.push(`create:start:${page.textObject?.[0].content}`);
    const result = await createDone.promise;
    calls.push("create:end");
    return result;
  });
  bridge.textContainerUpgrade.mockImplementation(async ({ content }) => {
    calls.push(`write:start:${content}`);
    const result = await writeDone.promise;
    calls.push(`write:end:${content}`);
    return result;
  });
  bridge.shutDownPageContainer.mockImplementation(async (mode) => {
    calls.push(`shutdown:start:${mode}`);
    const result = await shutdownDone.promise;
    calls.push("shutdown:end");
    return result;
  });

  const scheduler = new SerialBridgeScheduler(bridge, 120);
  const started = scheduler.start(idleText);
  const superseded = scheduler.setText("discarded card");
  await advance(80);
  const write = scheduler.setText(readyText);
  await advance(120);
  expect(calls).toEqual([`create:start:${idleText}`]);
  await expect(superseded).resolves.toBe(false);

  createDone.resolve(StartUpPageCreateResult.success);
  await started;
  await advance(0);
  expect(calls).toEqual([`create:start:${idleText}`, "create:end", `write:start:${readyText}`]);
  const shutdown = scheduler.shutdown();
  await advance();
  expect(calls).toEqual([`create:start:${idleText}`, "create:end", `write:start:${readyText}`]);

  writeDone.resolve(true);
  await write;
  await advance(0);
  const redraw = scheduler.setText(idleText);
  await advance();
  const beforeShutdownEnds = [`create:start:${idleText}`, "create:end", `write:start:${readyText}`,
    `write:end:${readyText}`, "shutdown:start:1"];
  expect(calls).toEqual(beforeShutdownEnds);
  shutdownDone.resolve(true);
  await shutdown;
  await expect(redraw).resolves.toBe(true);
  expect(calls).toEqual([...beforeShutdownEnds, "shutdown:end", `write:start:${idleText}`, `write:end:${idleText}`]);

  const next = scheduler.setText("CONFLICT HOLD");
  await advance(119);
  expect(calls.at(-1)).toBe(`write:end:${idleText}`);
  await advance(1);
  await expect(next).resolves.toBe(true);
  expect(calls.slice(-2)).toEqual(["write:start:CONFLICT HOLD", "write:end:CONFLICT HOLD"]);
});
