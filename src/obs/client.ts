import OBSWebSocket from 'obs-websocket-js';
import { EventEmitter } from 'node:events';

export interface ObsClientOptions {
  host: string;
  port: number;
  password: string;
  sourceJa: string;
  sourceEn: string;
  /** Reconnect interval in ms. 0 to disable. */
  reconnectMs?: number;
}

const TEXT_INPUT_KINDS = ['text_gdiplus_v3', 'text_ft2_source_v2'] as const;

export class ObsClient extends EventEmitter<{
  connected: [];
  disconnected: [];
  error: [Error];
}> {
  private ws: OBSWebSocket;
  private readonly opts: Required<ObsClientOptions>;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  // Reconnect-loop dedupe: emit the first occurrence of a given error message,
  // then suppress consecutive duplicates and surface a summary every 60s.
  private lastErrorKey = '';
  private lastErrorEmitAt = 0;
  private suppressedErrorCount = 0;
  private static readonly ERROR_DEDUPE_WINDOW_MS = 60_000;

  constructor(opts: ObsClientOptions) {
    super();
    this.opts = { reconnectMs: 5000, ...opts };
    this.ws = new OBSWebSocket();
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.setupListeners();
    const url = `ws://${this.opts.host}:${this.opts.port}`;
    const password = this.opts.password || undefined;

    try {
      await this.ws.connect(url, password);
    } catch (err) {
      // Schedule retry so late-launched OBS is picked up automatically
      if (!this.intentionalDisconnect && this.opts.reconnectMs > 0) {
        this.scheduleReconnect();
      }
      throw err;
    }
    this.connected = true;
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    if (!this.connected) return;
    await this.ws.disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Update connection options (applied on next reconnect). */
  updateOpts(opts: Partial<ObsClientOptions>): void {
    Object.assign(this.opts, opts);
  }

  /** Force an immediate reconnection attempt. */
  async reconnect(): Promise<void> {
    this.cancelReconnect();
    if (this.connected) {
      await this.disconnect();
    }
    this.ws = new OBSWebSocket();
    await this.connect();
  }

  async updateSubtitle(ja: string, en: string): Promise<void> {
    if (!this.connected) return;
    if (!this.opts.sourceJa && !this.opts.sourceEn) return;

    try {
      const calls: Promise<unknown>[] = [];
      if (this.opts.sourceJa) {
        calls.push(this.ws.call('SetInputSettings', {
          inputName: this.opts.sourceJa,
          inputSettings: { text: ja },
          overlay: true,
        }));
      }
      if (this.opts.sourceEn) {
        calls.push(this.ws.call('SetInputSettings', {
          inputName: this.opts.sourceEn,
          inputSettings: { text: en },
          overlay: true,
        }));
      }
      await Promise.all(calls);
    } catch (err) {
      // Swallow errors from disconnected state (race condition)
      if (this.connected) {
        throw err;
      }
    }
  }

  async clearSubtitle(): Promise<void> {
    await this.updateSubtitle('', '');
  }

  /** Send closed caption text to the active stream. */
  async sendCaption(text: string): Promise<void> {
    if (!this.connected || !text) return;
    try {
      await this.ws.call('SendStreamCaption', { captionText: text });
    } catch {
      // Silently ignore — stream may not be active
    }
  }

  /** Enumerate text input sources from OBS (GDI+ and FreeType2). */
  async getTextSources(): Promise<string[]> {
    if (!this.connected) return [];

    const results = await Promise.all(
      TEXT_INPUT_KINDS.map((kind) => this.ws.call('GetInputList', { inputKind: kind })),
    );
    const names = results.flatMap(
      ({ inputs }) => (inputs as Array<{ inputName: string }>).map((i) => i.inputName),
    );
    return names.sort();
  }

  private setupListeners(): void {
    this.ws.on('ConnectionClosed', () => {
      this.connected = false;
      this.emit('disconnected');
      if (!this.intentionalDisconnect && this.opts.reconnectMs > 0) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('ConnectionError', (err) => {
      this.emitDedupedError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private emitDedupedError(err: Error): void {
    const key = err.message || err.name || 'unknown';
    const now = Date.now();
    const sameAsLast = key === this.lastErrorKey;
    const withinWindow = now - this.lastErrorEmitAt < ObsClient.ERROR_DEDUPE_WINDOW_MS;

    if (sameAsLast && withinWindow) {
      this.suppressedErrorCount++;
      return;
    }

    if (sameAsLast && this.suppressedErrorCount > 0) {
      const seconds = Math.round((now - this.lastErrorEmitAt) / 1000);
      this.emit('error', new Error(`${key} (suppressed ${this.suppressedErrorCount} similar errors over ${seconds}s)`));
    } else {
      this.emit('error', err);
    }
    this.lastErrorKey = key;
    this.lastErrorEmitAt = now;
    this.suppressedErrorCount = 0;
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    this.reconnectTimer = setTimeout(async () => {
      try {
        // Need a fresh WebSocket instance after disconnect
        this.ws = new OBSWebSocket();
        await this.connect();
      } catch {
        // connect() already scheduled the next retry
      }
    }, this.opts.reconnectMs);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
