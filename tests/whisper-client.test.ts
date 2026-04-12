import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhisperClient } from '../src/recognition/whisper-client.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  };
}

describe('WhisperClient', () => {
  let client: WhisperClient;

  beforeEach(() => {
    client = new WhisperClient({ server: 'http://127.0.0.1:8080', timeoutMs: 5000, maxRetries: 0 });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('infer sends correct FormData for transcribe', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: 'こんにちは' }));

    const result = await client.infer(new Int16Array(16000), { language: 'ja', task: 'transcribe' });
    expect(result.text).toBe('こんにちは');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8080/inference');
    expect(opts.method).toBe('POST');

    const body = opts.body as FormData;
    expect(body.get('language')).toBe('ja');
    expect(body.get('response_format')).toBe('json');
    expect(body.get('translate')).toBeNull();
  });

  it('infer sends translate=true for translate task', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: 'Hello' }));

    await client.infer(new Int16Array(16000), { language: 'ja', task: 'translate' });

    const body = mockFetch.mock.calls[0]![1].body as FormData;
    expect(body.get('translate')).toBe('true');
  });

  it('transcribeAndTranslate makes two sequential requests', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ text: 'こんにちは' }))
      .mockResolvedValueOnce(jsonResponse({ text: 'Hello' }));

    const result = await client.transcribeAndTranslate(new Int16Array(16000), 'ja', true);
    expect(result.ja).toBe('こんにちは');
    expect(result.en).toBe('Hello');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('transcribeAndTranslate skips translate when disabled', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: 'こんにちは' }));

    const result = await client.transcribeAndTranslate(new Int16Array(16000), 'ja', false);
    expect(result.ja).toBe('こんにちは');
    expect(result.en).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws on server error', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500));

    await expect(client.infer(new Int16Array(100), { language: 'ja', task: 'transcribe' }))
      .rejects.toThrow('whisper.cpp server error');
  });

  it('trims text result', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: '  hello  ' }));

    const result = await client.infer(new Int16Array(100), { language: 'ja', task: 'transcribe' });
    expect(result.text).toBe('hello');
  });

  it('handles missing text field', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    const result = await client.infer(new Int16Array(100), { language: 'ja', task: 'transcribe' });
    expect(result.text).toBe('');
  });

  it('ping returns true when server responds', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const ok = await client.ping();
    expect(ok).toBe(true);
  });

  it('ping returns false on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const ok = await client.ping();
    expect(ok).toBe(false);
  });
});
