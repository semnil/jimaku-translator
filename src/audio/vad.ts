import * as ort from 'onnxruntime-node';
import { EventEmitter } from 'node:events';

/**
 * Silero VAD v5 wrapper using ONNX Runtime.
 *
 * Expects 16kHz mono audio. Processes in 512-sample (32ms) chunks.
 * Emits 'speech' events with the accumulated audio when speech ends.
 */

const CHUNK_SIZE = 512;  // 32ms at 16kHz
const CONTEXT_SIZE = 64; // context prepended to each chunk (required by Silero VAD)
const STATE_DIM = 128;
const SILENCE_RESET_SAMPLES = 16000 * 3; // Reset LSTM after 3s of non-speech to avoid hidden-state drift
const PRE_SPEECH_PAD_SAMPLES = 16000 * 0.5; // 500ms prepended to detected speech
// Extra silence retained after silenceMs is reached so Whisper sees the
// natural sentence ending. Without this tail, end-of-utterance punctuation
// (e.g. 「。」) is frequently dropped because the segment is sliced flush
// against the last voiced frame.
const TAIL_PAD_SAMPLES = Math.round(16000 * 0.125); // 125ms

export interface VadOptions {
  /** Model file path. */
  modelPath: string;
  /** Speech probability threshold (0-1). */
  threshold: number;
  /** Minimum speech duration in ms. Shorter segments are discarded. */
  minSpeechMs: number;
  /** Maximum speech duration in ms. Longer segments are split. */
  maxSpeechMs: number;
  /** Silence duration in ms after speech to trigger end-of-speech. */
  silenceMs?: number;
}

export interface SpeechSegment {
  /** 16kHz mono INT16 PCM samples of the speech segment. */
  samples: Int16Array;
  /** Duration in milliseconds. */
  durationMs: number;
}

export interface VadDiag {
  chunks: number;
  maxProb: number;
  threshold: number;
  isSpeech: boolean;
  speechMs: number;
}

export class SileroVad extends EventEmitter<{
  speech: [SpeechSegment];
  error: [Error];
  diag: [VadDiag];
}> {
  private session: ort.InferenceSession | null = null;
  private state: ort.Tensor;
  private srTensor: ort.Tensor;

  private opts: Required<VadOptions>;

  // Buffering state
  private context: Float32Array = new Float32Array(CONTEXT_SIZE); // rolling context window
  private residual: Float32Array = new Float32Array(0);
  private isSpeech = false;
  private speechSamples: Int16Array[] = [];
  private speechSampleCount = 0;
  private silenceSamples = 0;

  // Pre-speech ring buffer — VAD detects speech a few chunks after actual onset,
  // so we keep recent silence chunks and prepend them when speech starts.
  private preSpeechBuffer: Int16Array[] = [];
  private preSpeechSampleCount = 0;

  // Serialize feed() calls to prevent concurrent access to residual/state
  private feedQueue: Promise<void> = Promise.resolve();
  private feedQueueDepth = 0;

  // Auto-reset LSTM state after prolonged silence
  private silenceSinceLastSpeech = 0;

  // Linear RMS floor for speech continuation. While inSpeech, chunks whose
  // RMS stays at/above this value do NOT count toward silenceMs termination
  // even if the VAD model's prob dips below threshold — this prevents Silero's
  // known prob collapse on sustained vowels from cutting the segment short.
  private continuationRmsFloor = 0;

  // Diagnostics
  private chunkCount = 0;
  private maxProb = 0;
  private lastDiagTime = 0;
  private lastProbValue = 0;
  private maxProbSinceRead = 0;

  constructor(opts: VadOptions) {
    super();
    this.opts = {
      silenceMs: 600,
      ...opts,
    };

    // Initial LSTM state: zeros [2, 1, 128]
    this.state = new ort.Tensor(
      'float32',
      new Float32Array(2 * 1 * STATE_DIM),
      [2, 1, STATE_DIM],
    );

    // Sample rate tensor
    this.srTensor = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
  }

  updateOpts(opts: Partial<Pick<VadOptions, 'threshold' | 'minSpeechMs' | 'maxSpeechMs'>>): void {
    Object.assign(this.opts, opts);
  }

  /** Set the linear-amplitude RMS floor used for speech-continuation fallback. */
  setContinuationFloor(linear: number): void {
    this.continuationRmsFloor = linear;
  }

  /** True while a speech segment is being accumulated (between onset and end-of-speech). */
  get inSpeech(): boolean {
    return this.isSpeech;
  }

  /** Most recent speech probability (0-1) from the VAD model. */
  get lastProb(): number {
    return this.lastProbValue;
  }

  /**
   * Returns the peak speech probability observed since the last call to this
   * method, then resets the tracker. Lets callers sample the VAD between
   * polling intervals without missing a transient spike.
   */
  takeMaxProb(): number {
    const v = this.maxProbSinceRead;
    this.maxProbSinceRead = 0;
    return v;
  }

  /** Configured speech threshold (0-1). */
  get threshold(): number {
    return this.opts.threshold;
  }

  /** Samples of silence accumulated since the last detected speech chunk (0 while in speech). */
  get silenceSinceLastSpeechSamples(): number {
    return this.silenceSinceLastSpeech;
  }

  /** Feed queue depth (number of awaiting feed() calls). */
  get queueDepth(): number {
    return this.feedQueueDepth;
  }

  async init(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.opts.modelPath);
  }

  /**
   * Feed 16kHz mono INT16 PCM samples into the VAD.
   * Internally converts to float32 and processes in 512-sample chunks.
   * Calls are serialized to prevent concurrent access to residual/state.
   */
  feed(int16Samples: Int16Array): Promise<void> {
    // Drop audio if the queue is backed up to prevent unbounded growth.
    // Real-time VAD must keep pace with incoming audio; stale data is useless.
    if (this.feedQueueDepth >= 4) {
      return Promise.resolve();
    }
    this.feedQueueDepth++;
    // .catch() ensures the chain survives previous errors — without it,
    // a single rejected feedInternal permanently breaks the queue.
    this.feedQueue = this.feedQueue
      .catch(() => {})
      .then(() => this.feedInternal(int16Samples))
      .finally(() => { this.feedQueueDepth--; });
    return this.feedQueue;
  }

  private async feedInternal(int16Samples: Int16Array): Promise<void> {
    if (!this.session) throw new Error('VAD not initialized. Call init() first.');

    // Convert INT16 to Float32 [-1, 1]
    const float32 = new Float32Array(int16Samples.length);
    for (let i = 0; i < int16Samples.length; i++) {
      float32[i] = int16Samples[i]! / 32768;
    }

    // Prepend any residual from previous call
    let data: Float32Array;
    if (this.residual.length > 0) {
      data = new Float32Array(this.residual.length + float32.length);
      data.set(this.residual);
      data.set(float32, this.residual.length);
      this.residual = new Float32Array(0);
    } else {
      data = float32;
    }

    // Process full chunks
    let offset = 0;
    while (offset + CHUNK_SIZE <= data.length) {
      const chunk = data.subarray(offset, offset + CHUNK_SIZE);
      await this.processChunk(chunk, int16Samples, offset);
      offset += CHUNK_SIZE;
    }

    // Save residual
    if (offset < data.length) {
      this.residual = data.slice(offset);
    }
  }

  private async processChunk(
    chunk: Float32Array,
    _originalInt16: Int16Array,
    _offset: number,
  ): Promise<void> {
    // Prepend context (last 64 samples from previous chunk) as required by Silero VAD
    const withContext = new Float32Array(CONTEXT_SIZE + CHUNK_SIZE);
    withContext.set(this.context);
    withContext.set(chunk, CONTEXT_SIZE);

    const inputTensor = new ort.Tensor('float32', withContext, [1, CONTEXT_SIZE + CHUNK_SIZE]);

    const results = await this.session!.run({
      input: inputTensor,
      state: this.state,
      sr: this.srTensor,
    });

    // Update state and context
    this.state = results['stateN'] as ort.Tensor;
    this.context = withContext.slice(-CONTEXT_SIZE);

    // Get speech probability
    const prob = (results['output'] as ort.Tensor).data[0] as number;
    this.lastProbValue = prob;
    if (prob > this.maxProbSinceRead) this.maxProbSinceRead = prob;

    // Diagnostics
    this.chunkCount++;
    if (prob > this.maxProb) this.maxProb = prob;
    const now = Date.now();
    if (now - this.lastDiagTime >= 5000) {
      this.emit('diag', {
        chunks: this.chunkCount,
        maxProb: this.maxProb,
        threshold: this.opts.threshold,
        isSpeech: this.isSpeech,
        speechMs: (this.speechSampleCount / 16000) * 1000,
      });
      this.chunkCount = 0;
      this.maxProb = 0;
      this.lastDiagTime = now;
    }

    const chunkInt16 = this.floatToInt16(chunk);
    const maxSpeechSamples = (this.opts.maxSpeechMs / 1000) * 16000;
    const minSpeechSamples = (this.opts.minSpeechMs / 1000) * 16000;
    const silenceThreshold = (this.opts.silenceMs / 1000) * 16000;

    if (prob >= this.opts.threshold) {
      // Speech detected
      this.silenceSamples = 0;
      this.silenceSinceLastSpeech = 0;

      if (!this.isSpeech) {
        this.isSpeech = true;
        // Prepend pre-speech buffer to capture the onset VAD missed
        for (const preChunk of this.preSpeechBuffer) {
          this.speechSamples.push(preChunk);
          this.speechSampleCount += preChunk.length;
        }
        this.preSpeechBuffer = [];
        this.preSpeechSampleCount = 0;
      }

      this.speechSamples.push(chunkInt16);
      this.speechSampleCount += chunkInt16.length;

      // Force split if exceeding max duration.
      if (this.speechSampleCount >= maxSpeechSamples) {
        this.emitSpeech();
      }
    } else {
      // Silence
      if (this.isSpeech) {
        // Still accumulate during grace period
        this.speechSamples.push(chunkInt16);
        this.speechSampleCount += chunkInt16.length;

        // Energy-based continuation fallback: Silero VAD's prob collapses on
        // sustained vowels. If the chunk still has audible energy above the
        // continuation floor, treat it as speech for termination purposes —
        // but keep prob-derived `silenceSamples` unchanged otherwise so a
        // genuine pause still ends the segment after silenceMs.
        let chunkRms = 0;
        if (this.continuationRmsFloor > 0) {
          let sum = 0;
          for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
          chunkRms = Math.sqrt(sum / chunk.length);
        }
        if (chunkRms >= this.continuationRmsFloor) {
          this.silenceSamples = 0;
        } else {
          this.silenceSamples += CHUNK_SIZE;
        }

        if (this.silenceSamples >= silenceThreshold + TAIL_PAD_SAMPLES) {
          // End of speech
          if (this.speechSampleCount >= minSpeechSamples) {
            this.emitSpeech();
          } else {
            // Too short, discard
            this.resetSpeech();
          }
        } else if (this.speechSampleCount >= maxSpeechSamples) {
          // Force split: prob may have collapsed mid-utterance (Silero vowel
          // saturation) and the energy-based continuation fallback keeps
          // silenceSamples pinned at 0. Without this branch the segment grows
          // unbounded and Whisper Dispatch never fires for the chunk.
          this.emitSpeech();
        }
      } else {
        // Append to pre-speech ring buffer for potential future onset
        this.preSpeechBuffer.push(chunkInt16);
        this.preSpeechSampleCount += chunkInt16.length;
        while (this.preSpeechSampleCount > PRE_SPEECH_PAD_SAMPLES && this.preSpeechBuffer.length > 0) {
          const removed = this.preSpeechBuffer.shift()!;
          this.preSpeechSampleCount -= removed.length;
        }

        // Prolonged non-speech: reset LSTM to prevent state drift
        this.silenceSinceLastSpeech += CHUNK_SIZE;
        if (this.silenceSinceLastSpeech >= SILENCE_RESET_SAMPLES) {
          this.resetState();
        }
      }
    }
  }

  private emitSpeech(): void {
    const total = this.speechSampleCount;
    const merged = new Int16Array(total);
    let offset = 0;
    for (const chunk of this.speechSamples) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    this.emit('speech', {
      samples: merged,
      durationMs: (total / 16000) * 1000,
    });

    // Reset LSTM hidden state between utterances. Keeping it across segments
    // causes prob to collapse — once the model has "committed" to a speech
    // region, the state biases toward low prob on subsequent chunks even when
    // audio energy is high, blocking detection of the next utterance.
    this.resetState();
  }

private resetSpeech(): void {
    this.isSpeech = false;
    this.speechSamples = [];
    this.speechSampleCount = 0;
    this.silenceSamples = 0;
  }

  /** Reset internal LSTM state. */
  resetState(): void {
    this.state = new ort.Tensor(
      'float32',
      new Float32Array(2 * 1 * STATE_DIM),
      [2, 1, STATE_DIM],
    );
    this.context = new Float32Array(CONTEXT_SIZE);
    this.residual = new Float32Array(0);
    this.silenceSinceLastSpeech = 0;
    this.preSpeechBuffer = [];
    this.preSpeechSampleCount = 0;
    this.resetSpeech();
  }

  private floatToInt16(float32: Float32Array): Int16Array {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = float32[i]! * 32768;
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    }
    return int16;
  }
}
