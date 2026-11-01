import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { Pipeline } from '../src/pipeline.js';

function pipelineWith(parts: { clear: () => Promise<void>; disconnect: () => Promise<void>; whisperStop: () => Promise<void> }) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const pipeline = new Pipeline('/nonexistent/config.toml');
  const internals = pipeline as unknown as Record<string, unknown>;
  internals.subtitle = Object.assign(new EventEmitter(), { clear: vi.fn(parts.clear) });
  internals.obs = Object.assign(new EventEmitter(), { disconnect: vi.fn(parts.disconnect) });
  const whisperProc = Object.assign(new EventEmitter(), { stop: vi.fn(parts.whisperStop) });
  internals.whisperProc = whisperProc;
  return { pipeline, whisperProc, obs: internals.obs as { disconnect: ReturnType<typeof vi.fn> } };
}

describe('Pipeline.stop', () => {
  it('stops whisper-server while OBS has not answered the subtitle clear', async () => {
    const { pipeline, whisperProc } = pipelineWith({
      clear: () => new Promise<void>(() => {}),
      disconnect: async () => {},
      whisperStop: async () => {},
    });
    void pipeline.stop();
    await vi.waitFor(() => expect(whisperProc.stop).toHaveBeenCalledTimes(1));
  });

  it('clears the subtitle, disconnects OBS and stops whisper-server', async () => {
    const { pipeline, whisperProc, obs } = pipelineWith({
      clear: async () => {},
      disconnect: async () => {},
      whisperStop: async () => {},
    });
    await pipeline.stop();
    expect(obs.disconnect).toHaveBeenCalledTimes(1);
    expect(whisperProc.stop).toHaveBeenCalledTimes(1);
  });

  it('stops whisper-server once when stop() is called again while it is stopping', async () => {
    let finish!: () => void;
    const { pipeline, whisperProc } = pipelineWith({
      clear: async () => {},
      disconnect: async () => {},
      whisperStop: () => new Promise<void>((resolve) => { finish = resolve; }),
    });
    const first = pipeline.stop();
    const second = pipeline.stop();
    finish();
    await Promise.all([first, second]);
    expect(whisperProc.stop).toHaveBeenCalledTimes(1);
  });
});
