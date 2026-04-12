import { encodeWav } from '../audio/wav.js';

export interface WhisperResult {
  text: string;
}

export interface WhisperClientOptions {
  /** Base URL of the whisper.cpp server, e.g. "http://127.0.0.1:8080" */
  server: string;
  /** Request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Max retries on transient errors. Default 1. */
  maxRetries?: number;
}

export class WhisperClient {
  private readonly server: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: WhisperClientOptions) {
    this.server = opts.server.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.maxRetries = opts.maxRetries ?? 1;
  }

  /**
   * Send INT16 mono 16kHz PCM audio to whisper.cpp server.
   * @param task 'transcribe' for source-language text, 'translate' for English
   */
  async infer(
    pcm16k: Int16Array,
    opts: { language: string; task: 'transcribe' | 'translate' },
  ): Promise<WhisperResult> {
    const wav = encodeWav(pcm16k, 16000);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('language', opts.language);
    form.append('response_format', 'json');
    if (opts.task === 'translate') {
      form.append('translate', 'true');
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const res = await fetch(`${this.server}/inference`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
          throw new Error(`whisper.cpp server error: ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as { text?: string };
        return { text: (data.text ?? '').trim() };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.name === 'AbortError') {
          lastError = new Error(`whisper.cpp request timed out after ${this.timeoutMs}ms`);
        }
        // Only retry on connection errors, not on server errors
        if (attempt < this.maxRetries) {
          await sleep(500 * (attempt + 1));
        }
      }
    }

    throw lastError!;
  }

  /**
   * Run transcribe (JA) then translate (EN) sequentially.
   * whisper.cpp server is single-threaded; parallel requests cause corruption.
   * If translate is disabled (turbo models), skips the translate step.
   */
  async transcribeAndTranslate(
    pcm16k: Int16Array,
    language = 'ja',
    translate = true,
  ): Promise<{ ja: string; en: string }> {
    const ja = await this.infer(pcm16k, { language, task: 'transcribe' });
    if (!translate) return { ja: ja.text, en: '' };

    const en = await this.infer(pcm16k, { language, task: 'translate' });
    return { ja: ja.text, en: en.text };
  }

  /** Health check: try to reach the server. */
  async ping(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(this.server, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
