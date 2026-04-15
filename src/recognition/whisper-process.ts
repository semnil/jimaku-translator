import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface WhisperProcessOptions {
  /** Path to whisper-server binary. */
  binary: string;
  /** Path to GGML model file. */
  model: string;
  /** Host to bind. Default 127.0.0.1. */
  host?: string;
  /** Port to bind. Extracted from server URL. */
  port: number;
  /** Thread count passed via --threads. Omit to let whisper-server decide. */
  threads?: number;
}

/**
 * Decide a reasonable default for `--threads` based on platform and the
 * currently selected binary variant. GPU-accelerated builds only need a few
 * CPU threads for pre/post-processing; CPU-only builds benefit from more
 * threads but we leave half the cores free for the rest of the pipeline.
 */
export function resolveThreadsDefault(variant: string): number {
  // macOS (Apple Silicon or Intel + Metal via Homebrew) — Metal offloads the
  // heavy math so a small thread count is optimal.
  if (process.platform === 'darwin') return 4;

  // Windows / Linux with GPU-accelerated variant — same reasoning as Metal.
  const v = variant.toLowerCase();
  if (v.includes('cublas') || v.includes('cuda') || v.includes('vulkan')) {
    return 4;
  }

  // CPU-only: use half the logical cores, minimum 1.
  const cores = os.cpus()?.length ?? 2;
  return Math.max(1, Math.floor(cores / 2));
}

export interface WhisperProcessEvents {
  ready: [];
  exit: [code: number | null, signal: string | null];
  error: [Error];
  log: [string];
}

export class WhisperProcess extends EventEmitter<WhisperProcessEvents> {
  private proc: ChildProcess | null = null;
  private readonly opts: Required<Omit<WhisperProcessOptions, 'threads'>> & { threads?: number };
  private stopping = false;

  constructor(opts: WhisperProcessOptions) {
    super();
    this.opts = { host: '127.0.0.1', ...opts };
  }

  /** Start the whisper-server process and wait until it's ready. */
  async start(): Promise<void> {
    if (this.proc) return;
    this.stopping = false;

    const args = [
      '-m', this.opts.model,
      '--host', this.opts.host,
      '--port', String(this.opts.port),
    ];
    if (this.opts.threads !== undefined) {
      args.push('--threads', String(this.opts.threads));
    }

    this.emit('log', `[Whisper] Starting: ${this.opts.binary} ${args.join(' ')}`);

    this.proc = spawn(this.opts.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(this.opts.binary),
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
    });

    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (!this.stopping) {
        this.emit('log', `[Whisper] Process exited unexpectedly (code=${code}, signal=${signal})`);
      }
      this.emit('exit', code, signal);
    });

    // Forward stdout/stderr as log lines
    const handleOutput = (data: Buffer) => {
      const lines = data.toString('utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        this.emit('log', `[Whisper] ${line}`);
      }
    };

    this.proc.stdout?.on('data', handleOutput);
    this.proc.stderr?.on('data', handleOutput);

    // Wait for server to become ready by polling the health endpoint
    await this.waitForReady();
  }

  /** Stop the whisper-server process. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    this.stopping = true;

    const proc = this.proc;
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  isRunning(): boolean {
    return this.proc !== null && !this.stopping;
  }

  private async waitForReady(): Promise<void> {
    const url = `http://${this.opts.host}:${this.opts.port}`;
    const maxAttempts = 30; // 30 * 1s = 30s max wait

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          this.emit('ready');
          this.emit('log', '[Whisper] Server ready');
          return;
        }
      } catch {
        // Not ready yet
      }

      if (!this.proc) {
        throw new Error('Whisper process exited before becoming ready');
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`Whisper server did not become ready within ${maxAttempts}s`);
  }
}
