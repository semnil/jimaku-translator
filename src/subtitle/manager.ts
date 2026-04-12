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

export class SubtitleManager {
  private readonly obs: ObsClient;
  private opts: SubtitleManagerOptions;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(obs: ObsClient, opts: SubtitleManagerOptions) {
    this.obs = obs;
    this.opts = opts;
  }

  updateOpts(opts: Partial<SubtitleManagerOptions>): void {
    Object.assign(this.opts, opts);
  }

  /**
   * Display subtitle text. Resets the auto-clear timer.
   */
  async show(ja: string, en: string): Promise<void> {
    this.cancelClear();

    const formattedJa = this.breakLines(ja);
    const formattedEn = this.breakLines(en);

    if (!this.obs.isConnected()) return;

    await this.obs.updateSubtitle(formattedJa, formattedEn);

    if (this.opts.closedCaption) {
      await this.obs.sendCaption(this.opts.ccLanguage === 'en' ? en : ja);
    }

    this.scheduleClear();
  }

  /** Immediately clear subtitles. */
  async clear(): Promise<void> {
    this.cancelClear();
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
