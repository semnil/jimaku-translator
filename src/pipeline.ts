import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { type Config, loadConfig } from './config.js';
import { VbanReceiver, type VbanAudioEvent } from './vban/receiver.js';
import { ObsClient } from './obs/client.js';
import { downmixToMono, resampleTo16k } from './audio/resample.js';
import { computeRms, dbfsToLinear, linearToDbfs, normalizeToTarget, NoiseFloorTracker } from './audio/level.js';
import { SileroVad, type SpeechSegment } from './audio/vad.js';
import { WhisperClient } from './recognition/whisper-client.js';
import { WhisperProcess, resolveThreadsDefault } from './recognition/whisper-process.js';
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
    /** Number of subtitle updates queued for OBS (held by clearDelay). */
    subtitlePending: number;
  };
  whisper: {
    server: string;
    inferring: boolean;
    queueLength: number;
  } & (
    | { reachable: true; reason: null }
    | { reachable: false; reason: 'no_binary' | 'no_model' | 'unreachable' | 'starting' }
  );
  lastResult: {
    ja: string;
    en: string;
    timestamp: number;
  } | null;
  audio: {
    /** Effective RMS gate in dBFS (max of static + adaptive, clamped by ceiling). */
    effectiveGateDb: number;
    /** Static RMS gate in dBFS (config value). */
    staticGateDb: number;
    /** Ceiling for the adaptive gate in dBFS. */
    maxGateDb: number;
    /** Instantaneous RMS in dBFS from the latest frame (-Infinity when silent). */
    rmsDb: number;
    /** True when VAD is currently inside an active speech segment. */
    inSpeech: boolean;
    /** True when the latest frame's RMS passed the effective gate. */
    gatePass: boolean;
    /** Epoch ms timestamp when audio was last dispatched to Whisper (0 = never). */
    lastWhisperSendAt: number;
    /** Peak VAD speech probability (0-1) since last status tick. */
    vadProb: number;
    /** Configured VAD speech threshold (0-1). */
    vadThreshold: number;
    /** Milliseconds of continuous non-speech since last detected speech chunk. */
    vadSilenceSinceLastSpeechMs: number;
    /** Number of pending feed() calls queued on the VAD. */
    vadQueueDepth: number;
  };
  ui: {
    showVadDebug: boolean;
  };
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
  private whisperStarting = false;
  /** Cached fs.existsSync results to keep getStatus() out of the syscall hot path. */
  private whisperPathCache: { binary: string; model: string; binaryExists: boolean; modelExists: boolean } | null = null;
  private lastResult: PipelineStatus['lastResult'] = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private lastEmittedJson = '';
  private logBuffer: string[] = [];
  private rmsSumSquares = 0;
  private rmsSampleCount = 0;
  private noiseFloor: NoiseFloorTracker | null = null;
  private lastFrameRmsLinear = 0;
  private lastFrameGatePass = false;
  private lastWhisperSendAt = 0;

  // Audio capture for WAV export
  private captureBuffer: Int16Array[] | null = null;
  private captureSampleCount = 0;
  private captureMaxSamples = 0;
  private captureResolve: ((samples: Int16Array) => void) | null = null;
  private captureReject: ((err: Error) => void) | null = null;
  private captureTimeout: ReturnType<typeof setTimeout> | null = null;
  private captureFirstPacketTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.whisperPathCache = null;
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
    const windowChanged = audio.adaptive_gate_window_sec !== this.config.audio.adaptive_gate_window_sec;
    this.config.audio = { ...audio };
    if (windowChanged && this.noiseFloor) {
      this.noiseFloor = new NoiseFloorTracker(
        Math.max(10, Math.ceil(audio.adaptive_gate_window_sec * 100)),
        0.5,
      );
    }
  }

  updateUiConfig(ui: Config['ui']): void {
    this.config.ui = { ...ui };
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
    if (!this.vbanListening) {
      return Promise.reject(new Error('VBAN receiver is not listening'));
    }
    this.captureBuffer = [];
    this.captureSampleCount = 0;
    this.captureMaxSamples = Math.ceil((durationMs / 1000) * 16000);
    this.log(`[Capture] Recording ${durationMs}ms...`);

    return new Promise((resolve, reject) => {
      this.captureResolve = resolve;
      this.captureReject = reject;
      // First-packet watchdog: abort early if no VBAN audio arrives at all.
      this.captureFirstPacketTimer = setTimeout(() => {
        if (this.captureSampleCount === 0) {
          this.cancelCapture(new Error('No VBAN audio received within 2s — check sender'));
        }
      }, 2000);
      // Hard timeout: reject if capture doesn't complete within 2x the requested duration
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
    if (this.captureFirstPacketTimer) {
      clearTimeout(this.captureFirstPacketTimer);
      this.captureFirstPacketTimer = null;
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
        subtitlePending: this.subtitle?.getPendingCount() ?? 0,
      },
      whisper: this.whisperReachable
        ? {
            reachable: true,
            reason: null,
            server: this.config.whisper.server,
            inferring: this.inferring,
            queueLength: this.inferQueue.length,
          }
        : {
            reachable: false,
            reason: this.computeWhisperReason() ?? 'unreachable',
            server: this.config.whisper.server,
            inferring: this.inferring,
            queueLength: this.inferQueue.length,
          },
      lastResult: this.lastResult,
      audio: {
        effectiveGateDb: this.computeEffectiveGateDb(),
        staticGateDb: this.config.audio.rms_gate_db,
        maxGateDb: this.config.audio.adaptive_gate_max_db,
        rmsDb: this.lastFrameRmsLinear > 0 ? linearToDbfs(this.lastFrameRmsLinear) : -200,
        inSpeech: this.vbanListening ? (this.vad?.inSpeech ?? false) : false,
        gatePass: this.vbanListening ? this.lastFrameGatePass : false,
        lastWhisperSendAt: this.lastWhisperSendAt,
        vadProb: this.vbanListening && this.vad ? this.vad.takeMaxProb() : 0,
        vadThreshold: this.config.vad.threshold,
        vadSilenceSinceLastSpeechMs: this.vad
          ? (this.vad.silenceSinceLastSpeechSamples / 16000) * 1000
          : 0,
        vadQueueDepth: this.vad?.queueDepth ?? 0,
      },
      ui: {
        showVadDebug: !!this.config.ui.show_vad_debug,
      },
    };
  }

  private computeWhisperReason(): 'no_binary' | 'no_model' | 'unreachable' | 'starting' | null {
    if (this.whisperReachable) return null;
    if (this.whisperStarting) return 'starting';
    const binary = this.config.whisper.binary;
    const model = this.config.whisper.model;
    // External-server mode (no managed binary configured) → unreachable.
    if (!binary) return 'unreachable';
    // Reuse cached existence results when the configured paths haven't changed.
    // getStatus() is on the SSE hot path; sync stat per tick is wasted I/O.
    if (
      !this.whisperPathCache
      || this.whisperPathCache.binary !== binary
      || this.whisperPathCache.model !== model
    ) {
      this.whisperPathCache = {
        binary,
        model,
        binaryExists: fs.existsSync(binary),
        modelExists: !!model && fs.existsSync(model),
      };
    }
    if (!this.whisperPathCache.binaryExists) return 'no_binary';
    if (!this.whisperPathCache.modelExists) return 'no_model';
    return 'unreachable';
  }

  private computeEffectiveGateDb(): number {
    const staticDb = this.config.audio.rms_gate_db;
    const maxDb = this.config.audio.adaptive_gate_max_db;
    if (!this.config.audio.adaptive_gate_enabled || !this.noiseFloor) {
      return Math.min(staticDb, maxDb);
    }
    const floor = this.noiseFloor.estimate();
    if (floor === null) return Math.min(staticDb, maxDb);
    const adaptiveDb = linearToDbfs(floor) + this.config.audio.adaptive_gate_margin_db;
    const best = Number.isFinite(adaptiveDb) && adaptiveDb > staticDb ? adaptiveDb : staticDb;
    return Math.min(best, maxDb);
  }

  async start(): Promise<void> {
    // Reset transient state so a second start() after stop() doesn't carry
    // stale reachability flags or cached path-existence from a prior run.
    this.whisperReachable = false;
    this.whisperStarting = false;
    this.whisperPathCache = null;
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

    // lastResult is updated at the moment Whisper returns (see processQueue),
    // so the GUI reflects the recognition pace even while OBS is disconnected
    // or being held by clearDelay. The subtitle manager's clearDelay only
    // throttles OBS dispatch, not GUI display.

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

    // VBAN packets arrive ~100x/sec; size the noise-floor history to roughly
    // window_sec seconds of non-speech samples. Median (50th percentile) is
    // robust against the occasional gate-passing transient noise.
    this.noiseFloor = new NoiseFloorTracker(
      Math.max(10, Math.ceil(this.config.audio.adaptive_gate_window_sec * 100)),
      0.5,
    );

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
          if (this.captureFirstPacketTimer) {
            clearTimeout(this.captureFirstPacketTimer);
            this.captureFirstPacketTimer = null;
          }
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

        // RMS gate: skip VAD for audio below threshold to save compute and
        // prevent false positives on ambient noise. Bypassed once VAD is in
        // an active speech segment so brief intra-utterance dips (commas,
        // breaths) don't punch holes in the audio handed to Whisper.
        const rms = computeRms(resampled);
        const inSpeech = this.vad.inSpeech;
        this.lastFrameRmsLinear = rms;

        const maxGate = dbfsToLinear(this.config.audio.adaptive_gate_max_db);
        // Track ambient noise floor only outside speech AND only while below
        // the ceiling — otherwise a gate that climbs past real signal would
        // block all audio, starve VAD, and treat the signal as "noise",
        // creating a runaway feedback loop.
        if (!inSpeech && this.noiseFloor && rms < maxGate) {
          this.noiseFloor.add(rms);
        }

        const staticGate = dbfsToLinear(this.config.audio.rms_gate_db);
        let effectiveGate = staticGate;
        if (this.config.audio.adaptive_gate_enabled && this.noiseFloor) {
          const floor = this.noiseFloor.estimate();
          if (floor !== null) {
            const adaptive = floor * dbfsToLinear(this.config.audio.adaptive_gate_margin_db);
            if (adaptive > effectiveGate) effectiveGate = adaptive;
          }
        }
        if (effectiveGate > maxGate) effectiveGate = maxGate;

        const gatePass = rms >= effectiveGate;
        this.lastFrameGatePass = gatePass;

        // Use the effective gate as VAD's continuation floor so sustained
        // vowels (where Silero's prob collapses) still count as ongoing speech.
        this.vad.setContinuationFloor(effectiveGate);

        if (inSpeech || gatePass) {
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

      const threads = this.config.whisper.threads ?? resolveThreadsDefault(this.config.whisper.binary_variant);
      this.whisperProc = new WhisperProcess({
        binary: this.config.whisper.binary,
        model: this.config.whisper.model,
        host: '127.0.0.1',
        port: autoPort,
        threads,
      });
      this.log(`[Whisper] Using ${threads} thread(s)`);
      this.whisperProc.on('log', (msg) => this.log(msg));
      this.whisperProc.on('error', (err) => this.log(`[Whisper] Process error: ${err.message}`));
      this.whisperProc.on('exit', () => {
        this.whisperReachable = false;
      });
    }

    // OBS connect runs in the background: a missing/unreachable OBS must not
    // block pipeline startup. The client auto-reconnects, and updateSubtitle()
    // is guarded by isConnected().
    void this.connectObs().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[OBS] Initial connect error: ${msg}`);
    });
    const whisperReady = (async () => {
      if (this.whisperProc) {
        this.whisperStarting = true;
        try {
          await this.whisperProc.start();
          this.whisperReachable = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`[Whisper] Failed to start managed process: ${msg}`);
        } finally {
          this.whisperStarting = false;
        }
      } else {
        const ok = await this.whisper.ping();
        this.whisperReachable = ok;
        this.log(ok
          ? `[Whisper] Server reachable at ${this.config.whisper.server}`
          : `[Whisper] Server not reachable at ${this.config.whisper.server}`);
      }
    })();
    await whisperReady;

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
    }, 300);
  }

  async stop(): Promise<void> {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    this.vad?.removeAllListeners();
    this.subtitle?.removeAllListeners();
    this.receiver?.removeAllListeners();
    this.obs?.removeAllListeners();
    this.receiver?.stop();
    this.vbanListening = false;
    this.inferring = false;
    this.inferQueue = [];
    this.whisperReachable = false;
    this.whisperStarting = false;
    this.whisperPathCache = null;
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
    this.lastWhisperSendAt = start;

    try {
      // Determine canTranslate from model_name, or by matching the model filename
      const modelByName = MODEL_REGISTRY.find(m => m.id === this.config.whisper.model_name);
      const modelByFile = this.config.whisper.model
        ? MODEL_REGISTRY.find(m => this.config.whisper.model.endsWith(m.filename))
        : undefined;
      const canTranslate = (modelByFile ?? modelByName)?.canTranslate ?? true;
      const result = await this.whisper.transcribeAndTranslate(segment.samples, 'ja', canTranslate);
      const elapsed = Date.now() - start;

      const ja = (result.ja ?? '').replace(/[\r\n]+/g, ' ').trim();
      const en = (result.en ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (ja || en) {
        this.log(`[Whisper] ${elapsed}ms | JA: ${ja}`);
        this.log(`[Whisper]          | EN: ${en}`);
        // Update lastResult at Whisper-receive time so the GUI reflects the
        // recognition pace immediately, decoupled from OBS dispatch which is
        // throttled by clearDelay (and skipped while OBS is disconnected).
        this.lastResult = { ja, en, timestamp: Date.now() };
        await this.subtitle.show(ja, en).catch((e) => {
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
