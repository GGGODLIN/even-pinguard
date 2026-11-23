export { encodePcm16ToWav } from "./wav.js";

export interface SttPort {
  transcribe(wav: Uint8Array): Promise<string | null>;
}

export class GroqSttAdapter implements SttPort {
  constructor(
    private readonly apiKey?: string,
    private readonly options: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  async transcribe(wav: Uint8Array): Promise<string | null> {
    const apiKey = this.apiKey?.trim();
    if (!apiKey) return null;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, this.options.timeoutMs ?? 8_000);
    });
    try {
      return await Promise.race([this.request(wav, apiKey, controller.signal), deadline]);
    } catch {
      // Provider errors can contain authorization details. Voice failure is not an ops failure.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(wav: Uint8Array, apiKey: string, signal: AbortSignal): Promise<string | null> {
    const form = new FormData();
    form.set("model", "whisper-large-v3-turbo");
    form.set("file", new Blob([Uint8Array.from(wav)], { type: "audio/wav" }), "voice.wav");
    const response = await (this.options.fetch ?? fetch)("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form, signal, redirect: "error",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "text" in body && typeof body.text === "string"
      ? body.text.trim() || null
      : null;
  }
}
