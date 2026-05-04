import { EventEmitter } from 'node:events';
import { ObsClient } from '../obs/client.js';

export interface SubtitleManagerOptions {
  /** Seconds to wait before clearing subtitle after last update. */
  clearDelay: number;
  /** Max characters per line. Inserts newline if exceeded. */
  charsPerLine: number;
  /** Send closed captions to the active stream. */
  closedCaption: boolean;
  /** Language to send as closed caption. */
  ccLanguage: 'ja' | 'en';
}

export class SubtitleManager extends EventEmitter<{
  /** Fired exactly once after `show()` finishes processing a subtitle —
   * regardless of whether OBS was connected or `updateSubtitle()` threw.
   * Acts as a "dispatch attempt completed" marker so the GUI can flag
   * entries whose handler has run, separately from queue-pending ones. */
  displayed: [{ ja: string; en: string; seq?: number }];
  /** Fired when the active subtitle is cleared (either explicitly or via clearDelay). */
  cleared: [];
  /** Fired when the count of subtitles waiting for clearDelay changes. */
  pendingChanged: [number];
}> {
  private readonly obs: ObsClient;
  private opts: SubtitleManagerOptions;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingQueue: { ja: string; en: string; seq?: number }[] = [];
  private nextAllowedShowTime = 0;

  constructor(obs: ObsClient, opts: SubtitleManagerOptions) {
    super();
    this.obs = obs;
    this.opts = opts;
  }

  updateOpts(opts: Partial<SubtitleManagerOptions>): void {
    Object.assign(this.opts, opts);
  }

  /** Number of subtitles waiting for clearDelay before being sent to OBS. */
  getPendingCount(): number {
    return this.pendingQueue.length;
  }

  /**
   * Display subtitle text. Enforces clearDelay between successive updates:
   * if the previous subtitle has not yet reached its scheduled clear time,
   * the new content is enqueued and dispatched in FIFO order, each separated
   * by clearDelay. Every call is preserved (no coalescing); the queue is
   * bounded only by upstream backpressure.
   *
   * @param seq optional sequence number forwarded to the 'displayed' event
   *            so callers can correlate dispatches with their source records
   *            (e.g. to mark a result as sent in the GUI history).
   */
  async show(ja: string, en: string, seq?: number): Promise<void> {
    // Whisper translate output can contain \n / \r which would break
    // single-line OBS text sources; collapse to spaces before line wrapping.
    ja = ja.replace(/[\r\n]+/g, ' ').trim();
    en = en.replace(/[\r\n]+/g, ' ').trim();
    const now = Date.now();
    const wait = this.nextAllowedShowTime - now;
    // If a pending timer is already scheduled, always route through it so
    // the late-fire callback and a fresh direct call cannot race to update
    // the subtitle at the same instant (which would produce a visible
    // flicker/double-update when clearDelay expires exactly between them).
    if (wait > 0 || this.pendingTimer) {
      this.pendingQueue.push({ ja, en, seq });
      this.emit('pendingChanged', this.pendingQueue.length);
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => this.drainPending(), Math.max(0, wait));
      }
      return;
    }
    return this.showNow(ja, en, seq);
  }

  private drainPending(): void {
    this.pendingTimer = null;
    const next = this.pendingQueue.shift();
    if (!next) return;
    this.emit('pendingChanged', this.pendingQueue.length);
    void this.showNow(next.ja, next.en, next.seq)
      .catch(() => {})
      .finally(() => {
        if (this.pendingQueue.length === 0) return;
        const wait = Math.max(0, this.nextAllowedShowTime - Date.now());
        this.pendingTimer = setTimeout(() => this.drainPending(), wait);
      });
  }

  private async showNow(ja: string, en: string, seq?: number): Promise<void> {
    this.cancelClear();

    // Reserve the slot synchronously so any show() call arriving during the
    // OBS round-trip routes through the pending-timer path instead of racing
    // into a second showNow.
    this.nextAllowedShowTime = Date.now() + this.opts.clearDelay * 1000;

    const formattedJa = this.breakLines(ja);
    const formattedEn = this.breakLines(en);

    // Always emit 'displayed' once the OBS attempt has run (success, failure,
    // or skipped due to disconnect). The event is a "handler completed"
    // marker — actual OBS errors are surfaced via the rejected promise so
    // the caller can log them.
    try {
      if (this.obs.isConnected()) {
        await this.obs.updateSubtitle(formattedJa, formattedEn);
        if (this.opts.closedCaption) {
          await this.obs.sendCaption(this.opts.ccLanguage === 'en' ? en : ja);
        }
      }
    } finally {
      this.emit('displayed', { ja, en, seq });
      this.scheduleClear();
    }
  }

  /** Immediately clear subtitles. */
  async clear(): Promise<void> {
    this.cancelClear();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingQueue.length > 0) {
      this.pendingQueue = [];
      this.emit('pendingChanged', 0);
    }
    this.nextAllowedShowTime = 0;
    this.emit('cleared');
    if (!this.obs.isConnected()) return;
    await this.obs.clearSubtitle();
  }

  /**
   * Break text into lines at charsPerLine boundary.
   * 0 = no wrapping. For Japanese, breaks at any character.
   * For English/mixed, tries to break at word boundaries.
   */
  private breakLines(text: string): string {
    const max = this.opts.charsPerLine;
    if (max <= 0 || text.length <= max) return text;

    const lines: string[] = [];
    let remaining = text;

    while (remaining.length > max) {
      // Try to find a break point (space, punctuation) near the limit
      let breakAt = -1;
      for (let i = max; i >= max * 0.6; i--) {
        const ch = remaining[i];
        if (ch === ' ' || ch === '、' || ch === '。' || ch === '，' || ch === '．') {
          breakAt = i;
          break;
        }
      }

      if (breakAt === -1) {
        // No good break point; hard break at max
        breakAt = max;
      }

      lines.push(remaining.substring(0, breakAt).trimEnd());
      remaining = remaining.substring(breakAt).trimStart();
    }

    if (remaining.length > 0) {
      lines.push(remaining);
    }

    return lines.join('\n');
  }

  private scheduleClear(): void {
    this.clearTimer = setTimeout(async () => {
      this.emit('cleared');
      await this.obs.clearSubtitle().catch(() => {});
    }, this.opts.clearDelay * 1000);
  }

  private cancelClear(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }
}
