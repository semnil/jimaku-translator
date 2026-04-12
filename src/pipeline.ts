import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { type Config, loadConfig } from './config.js';
import { VbanReceiver, type VbanAudioEvent } from './vban/receiver.js';
import { ObsClient } from './obs/client.js';
import { downmixToMono, resampleTo16k } from './audio/resample.js';
import { computeRms, dbfsToLinear, normalizeToTarget } from './audio/level.js';
import { SileroVad, type SpeechSegment } from './audio/vad.js';
import { WhisperClient } from './recognition/whisper-client.js';
import { WhisperProcess } from './recognition/whisper-process.js';
import { SubtitleManager } from './subtitle/manager.js';
import { MODEL_REGISTRY } from './recognition/whisper-setup.js';

export interface PipelineStatus {
  vban: {
    listening: boolean;
    port: number;
    packetsPerSec: number;
    streamName: string;
    sampleRate: number;
    channels: number;
    /** Peak level 0-1 (after gain, before VAD). Updated every status tick. */
    peakLevel: number;
  };
  obs: {
    connected: boolean;
    host: string;
    port: number;
  };
  whisper: {
    reachable: boolean;
    server: string;
    inferring: boolean;
    queueLength: number;
  };
  lastResult: {
    ja: string;
    en: string;
    timestamp: number;
  } | null;
}

export interface PipelineEvents {
  status: [PipelineStatus];
  log: [string];
}

const MAX_QUEUE = 3;

/** Find a free TCP port on 127.0.0.1 by binding to port 0. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}


export class Pipeline extends EventEmitter<PipelineEvents> {
  private config: Config;
  private readonly configPath: string;

  private whisper!: WhisperClient;
  private whisperProc: WhisperProcess | null = null;
  private obs!: ObsClient;
  private subtitle!: SubtitleManager;
  private vad!: SileroVad;
  private receiver!: VbanReceiver;

  private inferring = false;
  private inferQueue: SpeechSegment[] = [];
  private lastLogTime = 0;

  private vbanListening = false;
  private lastStreamName = '';
  private lastSampleRate = 0;
  private lastChannels = 0;
  private whisperReachable = false;
  private lastResult: PipelineStatus['lastResult'] = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private lastEmittedJson = '';
  private logBuffer: string[] = [];
  private rmsSumSquares = 0;
  private rmsSampleCount = 0;

  // Audio capture for WAV export
  private captureBuffer: Int16Array[] | null = null;
  private captureSampleCount = 0;
  private captureMaxSamples = 0;
  private captureResolve: ((samples: Int16Array) => void) | null = null;
  private captureReject: ((err: Error) => void) | null = null;
  private captureTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(configPath: string) {
    super();
    this.configPath = configPath;
    this.config = loadConfig(configPath);
  }

  getConfig(): Config {
    return this.config;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getObs(): ObsClient | null {
    return this.obs ?? null;
  }

  updateWhisperConfig(whisper: Config['whisper']): void {
    this.config.whisper = { ...whisper };
  }

  updateObsConfig(obs: Config['obs']): void {
    this.config.obs = { ...obs };
    if (this.obs) {
      this.obs.updateOpts({
        host: obs.host,
        port: obs.port,
        password: obs.password,
        sourceJa: obs.source_ja,
        sourceEn: obs.source_en,
      });
    }
    if (this.subtitle) {
      this.subtitle.updateOpts({
        closedCaption: obs.closed_caption,
        ccLanguage: obs.cc_language,
      });
    }
  }

  updateSubtitleConfig(subtitle: Config['subtitle']): void {
    this.config.subtitle = { ...subtitle };
    if (this.subtitle) {
      this.subtitle.updateOpts({
        clearDelay: subtitle.clear_delay,
        charsPerLine: subtitle.chars_per_line,
      });
    }
  }

  updateVadConfig(vad: Config['vad']): void {
    this.config.vad = { ...vad };
    if (this.vad) {
      this.vad.updateOpts({
        threshold: vad.threshold,
        minSpeechMs: vad.min_speech_ms,
        maxSpeechMs: vad.max_speech_ms,
      });
    }
  }

  updateAudioConfig(audio: Config['audio']): void {
    this.config.audio = { ...audio };
  }

  updateVbanConfig(vban: Config['vban']): void {
    const portChanged = vban.port !== this.config.vban.port;
    this.config.vban = { ...vban };
    if (this.receiver) {
      if (portChanged) this.vbanListening = false;
      this.receiver.updateOpts({
        port: vban.port,
        streamName: vban.stream_name,
      });
    }
  }

  /**
   * Capture 16kHz mono audio as WAV.
   * Returns a promise that resolves with the captured INT16 samples.
   */
  captureAudio(durationMs: number): Promise<Int16Array> {
    if (this.captureBuffer) {
      return Promise.reject(new Error('Capture already in progress'));
    }
    this.captureBuffer = [];
    this.captureSampleCount = 0;
    this.captureMaxSamples = Math.ceil((durationMs / 1000) * 16000);
    this.log(`[Capture] Recording ${durationMs}ms...`);

    return new Promise((resolve, reject) => {
      this.captureResolve = resolve;
      this.captureReject = reject;
      // Timeout: reject if capture doesn't complete within 2x the requested duration
      this.captureTimeout = setTimeout(() => {
        this.cancelCapture(new Error('Capture timed out'));
      }, durationMs * 2 + 5000);
    });
  }

  private cancelCapture(err: Error): void {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    this.captureReject?.(err);
    this.captureBuffer = null;
    this.captureResolve = null;
    this.captureReject = null;
  }

  getStatus(): PipelineStatus {
    const elapsed = Date.now() - this.lastLogTime;
    const rawCount = this.receiver?.rawPacketCount ?? 0;
    const pps = elapsed > 0 ? (rawCount / elapsed) * 1000 : 0;

    return {
      vban: {
        listening: this.vbanListening,
        port: this.config.vban.port,
        packetsPerSec: Math.round(pps),
        streamName: this.lastStreamName,
        sampleRate: this.lastSampleRate,
        channels: this.lastChannels,
        peakLevel: this.rmsSampleCount > 0
          ? Math.sqrt(this.rmsSumSquares / this.rmsSampleCount) / 32768
          : 0,
      },
      obs: {
        connected: this.obs?.isConnected() ?? false,
        host: this.config.obs.host,
        port: this.config.obs.port,
      },
      whisper: {
        reachable: this.whisperReachable,
        server: this.config.whisper.server,
        inferring: this.inferring,
        queueLength: this.inferQueue.length,
      },
      lastResult: this.lastResult,
    };
  }

  async start(): Promise<void> {
    // In packaged Electron, __dirname is inside the asar archive.
    // Use process.resourcesPath (extraResources) for native addons like onnxruntime.
    const modelsDir = process.resourcesPath
      ? path.join(process.resourcesPath, 'models')
      : path.join(path.resolve(__dirname, '..'), 'models');
    const modelPath = path.join(modelsDir, 'silero_vad.onnx');

    this.whisper = new WhisperClient({ server: this.config.whisper.server });

    this.obs = new ObsClient({
      host: this.config.obs.host,
      port: this.config.obs.port,
      password: this.config.obs.password,
      sourceJa: this.config.obs.source_ja,
      sourceEn: this.config.obs.source_en,
    });

    this.subtitle = new SubtitleManager(this.obs, {
      clearDelay: this.config.subtitle.clear_delay,
      charsPerLine: this.config.subtitle.chars_per_line,
      closedCaption: this.config.obs.closed_caption,
      ccLanguage: this.config.obs.cc_language,
    });

    this.vad = new SileroVad({
      modelPath,
      threshold: this.config.vad.threshold,
      minSpeechMs: this.config.vad.min_speech_ms,
      maxSpeechMs: this.config.vad.max_speech_ms,
    });

    this.receiver = new VbanReceiver({
      port: this.config.vban.port,
      streamName: this.config.vban.stream_name,
    });

    this.vad.on('speech', (segment: SpeechSegment) => {
      this.log(`[VAD] Speech detected: ${segment.durationMs.toFixed(0)}ms, ${segment.samples.length} samples`);

      // Normalize to target RMS so Whisper receives consistent input levels.
      // 0 dBFS target = disabled.
      const target = this.config.audio.normalize_target_dbfs;
      const normalized = target < 0
        ? { samples: normalizeToTarget(segment.samples, target), durationMs: segment.durationMs }
        : segment;

      while (this.inferQueue.length >= MAX_QUEUE) {
        const dropped = this.inferQueue.shift()!;
        this.log(`[Queue] Dropped segment (${dropped.durationMs.toFixed(0)}ms) — whisper can't keep up`);
      }

      this.inferQueue.push(normalized);
      this.processQueue();
    });

    let resampleErrors = 0;
    let vadFeedErrors = 0;

    this.receiver.on('audio', (evt: VbanAudioEvent) => {
      this.lastStreamName = evt.streamName;
      this.lastSampleRate = evt.sampleRate;
      this.lastChannels = evt.channels;

      const mono = downmixToMono(evt.samples, evt.channels);

      // Accumulate RMS for the 1-second status tick
      for (let i = 0; i < mono.length; i++) {
        this.rmsSumSquares += mono[i]! * mono[i]!;
      }
      this.rmsSampleCount += mono.length;

      try {
        const resampled = resampleTo16k(mono, evt.sampleRate);

        // Audio capture for WAV export
        if (this.captureBuffer) {
          this.captureBuffer.push(resampled.slice());
          this.captureSampleCount += resampled.length;
          if (this.captureSampleCount >= this.captureMaxSamples) {
            const total = new Int16Array(this.captureSampleCount);
            let off = 0;
            for (const chunk of this.captureBuffer) {
              total.set(chunk, off);
              off += chunk.length;
            }
            this.log(`[Capture] Done: ${this.captureSampleCount} samples (${(this.captureSampleCount / 16000).toFixed(1)}s)`);
            if (this.captureTimeout) {
              clearTimeout(this.captureTimeout);
              this.captureTimeout = null;
            }
            this.captureResolve?.(total);
            this.captureBuffer = null;
            this.captureResolve = null;
            this.captureReject = null;
          }
        }

        // RMS gate: skip VAD for audio below threshold to save compute
        // and prevent false positives on ambient noise. Freezes VAD state
        // and pre-speech buffer until audio rises above the gate.
        const gateThreshold = dbfsToLinear(this.config.audio.rms_gate_db);
        const rms = computeRms(resampled);
        if (rms >= gateThreshold) {
          this.vad.feed(resampled).catch((err) => {
            vadFeedErrors++;
            if (vadFeedErrors <= 3) {
              this.log(`[VAD] Feed error: ${err.message}`);
            }
          });
        }
      } catch (err) {
        resampleErrors++;
        if (resampleErrors <= 3) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`[Resample] Error (sr=${evt.sampleRate}): ${msg}`);
        }
      }

    });

    this.receiver.on('error', (err) => {
      this.log(`[VBAN] Error: ${err.message}`);
    });

    this.receiver.on('listening', ({ port }) => {
      this.vbanListening = true;
      this.log(`[VBAN] Listening on UDP port ${port}`);
    });

    this.log('[VAD] Loading Silero VAD model...');
    await this.vad.init();
    this.log('[VAD] Model loaded');

    this.receiver.start();

    // Start managed whisper process if configured
    if (this.config.whisper.binary) {
      // Auto-assign a free port for the managed whisper-server
      const autoPort = await findFreePort();
      const whisperServer = `http://127.0.0.1:${autoPort}`;
      this.config.whisper.server = whisperServer;
      this.whisper = new WhisperClient({ server: whisperServer });
      this.log(`[Whisper] Auto-assigned port ${autoPort}`);

      this.whisperProc = new WhisperProcess({
        binary: this.config.whisper.binary,
        model: this.config.whisper.model,
        host: '127.0.0.1',
        port: autoPort,
      });
      this.whisperProc.on('log', (msg) => this.log(msg));
      this.whisperProc.on('error', (err) => this.log(`[Whisper] Process error: ${err.message}`));
      this.whisperProc.on('exit', () => {
        this.whisperReachable = false;
      });
    }

    // OBS connect, Whisper start/health-check run in parallel
    const obsReady = this.connectObs();
    const whisperReady = (async () => {
      if (this.whisperProc) {
        try {
          await this.whisperProc.start();
          this.whisperReachable = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`[Whisper] Failed to start managed process: ${msg}`);
        }
      } else {
        const ok = await this.whisper.ping();
        this.whisperReachable = ok;
        this.log(ok
          ? `[Whisper] Server reachable at ${this.config.whisper.server}`
          : `[Whisper] Server not reachable at ${this.config.whisper.server}`);
      }
    })();
    await Promise.all([obsReady, whisperReady]);

    this.lastLogTime = Date.now();
    this.statusInterval = setInterval(() => {
      const status = this.getStatus();
      const json = JSON.stringify(status);
      if (json !== this.lastEmittedJson) {
        this.lastEmittedJson = json;
        this.emit('status', status);
      }
      if (this.receiver) this.receiver.rawPacketCount = 0;
      this.rmsSumSquares = 0;
      this.rmsSampleCount = 0;
      this.lastLogTime = Date.now();
    }, 1000);
  }

  async stop(): Promise<void> {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    this.vad?.removeAllListeners();
    this.receiver?.removeAllListeners();
    this.obs?.removeAllListeners();
    this.receiver?.stop();
    this.vbanListening = false;
    this.inferring = false;
    this.inferQueue = [];
    this.cancelCapture(new Error('Pipeline stopped'));
    await this.subtitle?.clear().catch(() => {});
    await this.obs?.disconnect();
    if (this.whisperProc) {
      this.whisperProc.removeAllListeners();
      await this.whisperProc.stop();
      this.whisperProc = null;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.inferring) return;

    const segment = this.inferQueue.shift();
    if (!segment) return;

    this.inferring = true;
    const start = Date.now();

    try {
      // Determine canTranslate from model_name, or by matching the model filename
      const modelByName = MODEL_REGISTRY.find(m => m.id === this.config.whisper.model_name);
      const modelByFile = this.config.whisper.model
        ? MODEL_REGISTRY.find(m => this.config.whisper.model.endsWith(m.filename))
        : undefined;
      const canTranslate = (modelByFile ?? modelByName)?.canTranslate ?? true;
      const result = await this.whisper.transcribeAndTranslate(segment.samples, 'ja', canTranslate);
      const elapsed = Date.now() - start;

      if (result.ja || result.en) {
        this.log(`[Whisper] ${elapsed}ms | JA: ${result.ja}`);
        this.log(`[Whisper]          | EN: ${result.en}`);
        this.lastResult = { ja: result.ja, en: result.en, timestamp: Date.now() };
        await this.subtitle.show(result.ja, result.en).catch((e) => {
          this.log(`[OBS] Subtitle update failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[Whisper] Inference failed: ${msg}`);
    } finally {
      this.inferring = false;
      if (this.inferQueue.length > 0) {
        this.processQueue();
      }
    }
  }

  private async connectObs(): Promise<void> {
    this.obs.on('connected', () => {
      this.log(`[OBS] Connected to ws://${this.config.obs.host}:${this.config.obs.port}`);
    });
    this.obs.on('disconnected', () => {
      this.log('[OBS] Disconnected. Auto-reconnecting...');
    });
    this.obs.on('error', (err) => {
      this.log(`[OBS] Error: ${err.message}`);
    });

    try {
      await this.obs.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[OBS] Connection failed: ${msg}`);
      this.log('[OBS] Will auto-reconnect in background');
      return;
    }

    // Connection test — non-fatal: don't disrupt the connection on failure
    try {
      await this.subtitle.show('[接続テスト]', '[Connection Test]');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[OBS] Subtitle test failed (source may not exist): ${msg}`);
    }
  }

  getLogBuffer(): string[] {
    return this.logBuffer;
  }

  private log(message: string): void {
    console.log(message);
    if (this.logBuffer.length >= 500) this.logBuffer.shift();
    this.logBuffer.push(message);
    this.emit('log', message);
  }
}
