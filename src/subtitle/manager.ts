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
  /** Fired when a subtitle has been (or would have been) pushed to OBS. */
  displayed: [{ ja: string; en: string }];
  /** Fired when the active subtitle is cleared (either explicitly or via clearDelay). */
  cleared: [];
}> {
  private readonly obs: ObsClient;
  private opts: SubtitleManagerOptions;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLatest: { ja: string; en: string } | null = null;
  private nextAllowedShowTime = 0;

  constructor(obs: ObsClient, opts: SubtitleManagerOptions) {
    super();
    this.obs = obs;
    this.opts = opts;
  }

  updateOpts(opts: Partial<SubtitleManagerOptions>): void {
    Object.assign(this.opts, opts);
  }

  /**
   * Display subtitle text. Enforces clearDelay between successive updates:
   * if the previous subtitle has not yet reached its scheduled clear time,
   * the new content is held and shown once that time elapses. Later calls
   * during the hold replace the pending content (latest wins).
   */
  async show(ja: string, en: string): Promise<void> {
    const now = Date.now();
    const wait = this.nextAllowedShowTime - now;
    // If a pending timer is already scheduled, always route through it so
    // the late-fire callback and a fresh direct call cannot race to update
    // the subtitle at the same instant (which would produce a visible
    // flicker/double-update when clearDelay expires exactly between them).
    if (wait > 0 || this.pendingTimer) {
      this.pendingLatest = { ja, en };
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          const latest = this.pendingLatest;
          this.pendingLatest = null;
          if (latest) void this.showNow(latest.ja, latest.en).catch(() => {});
        }, Math.max(0, wait));
      }
      return;
    }
    return this.showNow(ja, en);
  }

  private async showNow(ja: string, en: string): Promise<void> {
    this.cancelClear();

    // Reserve the slot synchronously so any show() call arriving during the
    // OBS round-trip routes through the pending-timer path instead of racing
    // into a second showNow.
    this.nextAllowedShowTime = Date.now() + this.opts.clearDelay * 1000;

    const formattedJa = this.breakLines(ja);
    const formattedEn = this.breakLines(en);

    if (!this.obs.isConnected()) {
      this.emit('displayed', { ja, en });
      this.scheduleClear();
      return;
    }

    await this.obs.updateSubtitle(formattedJa, formattedEn);

    if (this.opts.closedCaption) {
      await this.obs.sendCaption(this.opts.ccLanguage === 'en' ? en : ja);
    }

    this.emit('displayed', { ja, en });
    this.scheduleClear();
  }

  /** Immediately clear subtitles. */
  async clear(): Promise<void> {
    this.cancelClear();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.pendingLatest = null;
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
