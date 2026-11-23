import {
  AudioInputSource,
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import type { EvenGlassesBridge } from "./glasses-controller.js";

const container = { containerID: 1, containerName: "startup" };

export class SerialBridgeScheduler {
  private tail = Promise.resolve();
  private pending?: { text: string; promise: Promise<boolean>; cancel: () => void };
  private lastRenderedText?: string;
  private renderEpoch = 0;
  private created = false;

  constructor(private readonly bridge: EvenGlassesBridge, private readonly debounceMs = 120) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  start(text: string): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          ...container, xPosition: 0, yPosition: 0, width: 576, height: 288,
          paddingLength: 8, isEventCapture: 1, content: text,
        })],
      }));
      if (result !== StartUpPageCreateResult.success) throw new Error(`Startup page rejected (${result})`);
      this.created = true;
      this.lastRenderedText = text;
    });
  }

  isShowing(text: string): boolean {
    return this.lastRenderedText === text;
  }

  setText(text: string): Promise<boolean> {
    if (this.pending?.text === text) return this.pending.promise;
    this.cancelText();
    if (this.isShowing(text)) return Promise.resolve(true);
    let cancel!: () => void;
    const promise = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.enqueue(async () => {
          if (this.pending?.promise !== promise) return false;
          this.pending = undefined;
          if (!this.created) return false;
          if (this.isShowing(text)) return true;
          const epoch = this.renderEpoch;
          this.lastRenderedText = undefined;
          const rendered = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ ...container, content: text }));
          if (rendered !== true || epoch !== this.renderEpoch) return false;
          this.lastRenderedText = text;
          return true;
        }).then(resolve, reject);
      }, this.debounceMs);
      cancel = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
    this.pending = { text, promise, cancel };
    return promise;
  }

  invalidateText(): void {
    // A write already in flight cannot vouch for the display after a lifecycle change.
    this.renderEpoch++;
    this.lastRenderedText = undefined;
    this.cancelText();
  }

  private cancelText(): void {
    this.pending?.cancel();
    this.pending = undefined;
  }

  setAudio(open: boolean, stillArmed = () => true): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.bridge.audioControl || (open && !stillArmed())) return false;
      try {
        return open
          ? await this.bridge.audioControl(true, AudioInputSource.Glasses)
          : await this.bridge.audioControl(false);
      } catch {
        return false;
      }
    });
  }

  shutdown(): Promise<boolean> {
    this.invalidateText();
    return this.enqueue(async () => await this.bridge.shutDownPageContainer(1));
  }
}
