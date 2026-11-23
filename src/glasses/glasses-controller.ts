import { AudioInputSource, DeviceConnectType, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import type { ClusterState, StateSnapshot } from "../engine/types.js";
import { encodePcm16ToWav, maxVoiceMs, maxVoicePcmBytes } from "../voice/wav.js";
import { SerialBridgeScheduler } from "./bridge-scheduler.js";
import { fitsLens, formatCard, idleText } from "./card-formatter.js";
import { parseEvenHubEvent } from "./event-parser.js";

export type EvenGlassesBridge = Pick<EvenAppBridge,
  "createStartUpPageContainer" | "textContainerUpgrade" | "shutDownPageContainer" |
  "onEvenHubEvent" | "onDeviceStatusChanged"> & Partial<Pick<EvenAppBridge, "audioControl">>;

export interface PinGuardApiClient {
  getState(): Promise<StateSnapshot>;
  executeCluster(action: { clusterId: string; expectedVersion: number }): Promise<unknown>;
  escalateConflict(action: { factKey: string; expectedVersion: number; wav?: Uint8Array<ArrayBuffer> }): Promise<unknown>;
}

type ArmedAction = { kind: "execute" | "escalate"; cluster: ClusterState };
type VoiceCapture = {
  chunks: Uint8Array[];
  size: number;
  recording: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closed?: Promise<boolean>;
};

function sameCard(a: ClusterState | undefined, b: ClusterState | undefined): boolean {
  if (!a || !b) return a === b;
  return a.cluster_id === b.cluster_id && a.fact_key === b.fact_key && a.version === b.version &&
    a.status === b.status && a.lock_state === b.lock_state && a.draft === b.draft && a.confirmed === b.confirmed;
}

function selectCluster({ clusters }: StateSnapshot): ClusterState | undefined {
  return clusters.find((cluster) => (cluster.status === "READY" && fitsLens(cluster.draft)) ||
    cluster.status === "HOLD_CONFLICT") ?? clusters[0];
}

export class GlassesController {
  private readonly scheduler: SerialBridgeScheduler;
  private readonly unsubscribe: (() => void)[] = [];
  private cluster?: ClusterState;
  private armed?: ArmedAction;
  private voice?: VoiceCapture;
  private armEpoch = 0;
  private started = false;
  private destroyed = false;
  private acting = false;
  private closing = 0;
  private nextRead = 0;
  private activeRead?: number;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly bridge: EvenGlassesBridge,
    private readonly api: PinGuardApiClient,
    private readonly options: { debounceMs?: number; pollIntervalMs?: number; onError?: (error: Error) => void } = {},
  ) {
    this.scheduler = new SerialBridgeScheduler(bridge, options.debounceMs);
  }

  async start(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;
    await this.scheduler.start(idleText);
    if (this.destroyed) return;
    this.unsubscribe.push(
      this.bridge.onEvenHubEvent((event) => this.run(this.handleEvent(event))),
      this.bridge.onDeviceStatusChanged(({ connectType }) => {
        if (connectType === DeviceConnectType.Disconnected || connectType === DeviceConnectType.ConnectionFailed) {
          this.run(this.handleDisconnect());
        }
      }),
    );
    if (this.options.pollIntervalMs !== undefined) {
      this.pollTimer = setInterval(() => {
        if (this.activeRead === undefined && !this.acting) this.run(this.refresh());
      }, this.options.pollIntervalMs);
    }
    await this.refresh();
  }

  applyState(snapshot: StateSnapshot): Promise<void> {
    this.activeRead = undefined;
    return this.updateCard(selectCluster(snapshot));
  }

  handleDisconnect(): Promise<void> {
    return this.rehydrate();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disarm();
    this.activeRead = undefined;
    clearInterval(this.pollTimer);
    this.scheduler.invalidateText();
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }

  private run(task: Promise<void>): void {
    void task.catch(console.error);
  }

  private async refresh(): Promise<void> {
    if (this.destroyed) return;
    const id = ++this.nextRead;
    this.activeRead = id;
    try {
      const snapshot = await this.api.getState();
      if (this.activeRead === id) await this.updateCard(selectCluster(snapshot));
    } catch (error) {
      if (this.activeRead === id) {
        await this.updateCard();
        throw error;
      }
    } finally {
      if (this.activeRead === id) this.activeRead = undefined;
    }
  }

  private async rehydrate(): Promise<void> {
    if (this.destroyed) return;
    this.disarm();
    this.scheduler.invalidateText();
    await Promise.all([this.updateCard(), this.refresh()]);
  }

  private updateCard(next?: ClusterState): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (!sameCard(this.cluster, next)) this.disarm();
    this.cluster = next && { ...next };
    return this.render();
  }

  private disarm(): VoiceCapture | undefined {
    this.armEpoch++;
    this.armed = undefined;
    const voice = this.voice;
    this.voice = undefined;
    if (voice) this.stopVoice(voice);
    return voice;
  }

  private stopVoice(voice: VoiceCapture): void {
    voice.recording = false;
    clearTimeout(voice.timer);
    voice.closed ??= this.scheduler.setAudio(false).then((closed) => {
      if (!closed) (this.options.onError ?? console.error)(new Error("Failed to close glasses microphone"));
      return closed;
    });
  }

  private async startVoice(): Promise<void> {
    if (!this.bridge.audioControl) return;
    const voice: VoiceCapture = { chunks: [], size: 0, recording: false };
    this.voice = voice;
    const opened = await this.scheduler.setAudio(true, () => this.voice === voice);
    if (!opened || this.voice !== voice) return;
    voice.recording = true;
    voice.timer = setTimeout(() => this.stopVoice(voice), maxVoiceMs);
  }

  private captureAudio(audio: EvenHubEvent["audioEvent"]): void {
    const voice = this.voice;
    const pcm = audio?.audioPcm;
    if (!voice?.recording || audio?.source === AudioInputSource.Phone || !(pcm instanceof Uint8Array) || !pcm.length) return;
    const chunk = pcm.slice(0, maxVoicePcmBytes - voice.size);
    voice.chunks.push(chunk);
    voice.size += chunk.length;
    if (voice.size >= maxVoicePcmBytes) this.stopVoice(voice);
  }

  private async render(): Promise<void> {
    if (this.destroyed || this.closing > 0) return;
    const cluster = this.armed?.cluster ?? this.cluster;
    await this.scheduler.setText(this.acting ? idleText : formatCard(cluster, !!this.armed).text);
  }

  private async handleEvent(raw: EvenHubEvent): Promise<void> {
    if (this.destroyed) return;
    const event = parseEvenHubEvent(raw);
    if (event === "EXIT") return this.destroy();
    if (event === "DOUBLE_CLICK") return this.requestExit();
    if (event === "FOREGROUND_ENTER") return this.rehydrate();
    if (this.acting || this.closing > 0) return;

    if (this.armed) {
      if (event === "SWIPE_UP") return this.dispatch(this.armed);
      if (event === "CLICK" || event === "SWIPE_DOWN") {
        this.disarm();
        return this.render();
      }
      if (this.armed.kind === "escalate") this.captureAudio(raw?.audioEvent);
      return;
    }
    if (event !== "CLICK" || !this.cluster) return;

    const cluster = this.cluster;
    const { text, oversized } = formatCard(cluster);
    // A failed or pending bridge write is not evidence that the operator saw this draft.
    if (oversized || !this.scheduler.isShowing(text)) return;
    if (cluster.status === "READY" && cluster.lock_state === "CLEAR") {
      this.armed = { kind: "execute", cluster };
    } else if (cluster.status === "HOLD_CONFLICT" && cluster.lock_state === "HOLD_CONFLICT") {
      this.armed = { kind: "escalate", cluster };
      this.run(this.startVoice());
    } else {
      return;
    }
    return this.render();
  }

  private async dispatch({ kind, cluster }: ArmedAction): Promise<void> {
    const voice = this.disarm();
    const epoch = this.armEpoch;
    this.acting = true;
    this.run(this.render());
    const { cluster_id: clusterId, fact_key: factKey, version: expectedVersion } = cluster;
    try {
      if (kind === "execute") {
        await this.api.executeCluster({ clusterId, expectedVersion });
      } else {
        if (voice) await voice.closed;
        // A pending bridge call can outlive the arm epoch; do not upload a canceled recording.
        if (epoch !== this.armEpoch) return;
        const wav = voice && voice.size >= 2 ? encodePcm16ToWav(voice.chunks) : undefined;
        await this.api.escalateConflict(wav ? { factKey, expectedVersion, wav } : { factKey, expectedVersion });
      }
    } finally {
      this.acting = false;
      await this.rehydrate();
    }
  }

  private async requestExit(): Promise<void> {
    this.disarm();
    this.closing++;
    try {
      await this.scheduler.shutdown();
    } finally {
      this.closing--;
      await this.render();
    }
  }
}
