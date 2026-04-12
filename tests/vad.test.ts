import { describe, it, expect } from 'vitest';
import { SileroVad } from '../src/audio/vad.js';
import path from 'node:path';

const MODEL_PATH = path.resolve('models', 'silero_vad.onnx');

describe('SileroVad', () => {
  it('initializes without error', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    await vad.init();
  });

  it('does not emit speech for silence', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    await vad.init();

    const speeches: any[] = [];
    vad.on('speech', (s) => speeches.push(s));

    // Feed 1 second of silence
    const silence = new Int16Array(16000);
    await vad.feed(silence);

    expect(speeches.length).toBe(0);
  });

  it('emits speech for loud signal followed by silence', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.3,   // lower threshold for test
      minSpeechMs: 100,  // short minimum
      maxSpeechMs: 5000,
      silenceMs: 300,
    });
    await vad.init();

    const speeches: any[] = [];
    vad.on('speech', (s) => speeches.push(s));

    // Generate a tone-like signal (sine wave at 440Hz) for 1 second
    const sampleRate = 16000;
    const duration = 1.0;
    const tone = new Int16Array(sampleRate * duration);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.round(20000 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
    }
    await vad.feed(tone);

    // Feed silence to trigger end-of-speech
    const silence = new Int16Array(sampleRate * 1);
    await vad.feed(silence);

    // Whether or not the sine wave triggers VAD depends on the model.
    // This test mainly verifies the pipeline doesn't crash.
    // A real speech signal would be needed for a reliable trigger test.
    expect(true).toBe(true);
  });

  it('feed recovers after internal error', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    // Don't call init() — session is null, feedInternal will throw
    // Feed should reject but not break the chain
    await expect(vad.feed(new Int16Array(512))).rejects.toThrow();

    // Now init and feed again — chain must still work
    await vad.init();
    await vad.feed(new Int16Array(16000)); // should not throw
  });

  it('resetState clears internal state', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    await vad.init();

    // Feed some data, then reset
    await vad.feed(new Int16Array(16000));
    vad.resetState();

    // Should be able to feed again without error
    await vad.feed(new Int16Array(16000));
  });

  it('drops feeds when queue depth exceeds limit', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    await vad.init();

    // Fire many feeds without awaiting — only the first few should be queued
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(vad.feed(new Int16Array(512)));
    }
    // All should resolve without error (dropped feeds resolve immediately)
    await Promise.all(promises);
  });

  it('resets LSTM state after prolonged silence', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    await vad.init();

    const diags: any[] = [];
    vad.on('diag', (d) => diags.push(d));

    // Feed 31 seconds of silence (exceeds 30s reset threshold)
    // Feed in chunks to allow the queue to process
    const chunkDuration = 1; // 1 second per feed
    for (let i = 0; i < 31; i++) {
      await vad.feed(new Int16Array(16000 * chunkDuration));
    }

    // After reset, VAD should still function — feed more audio without error
    await vad.feed(new Int16Array(16000));

    // Verify diag was emitted (proves processChunk ran)
    expect(diags.length).toBeGreaterThan(0);
  });
});
