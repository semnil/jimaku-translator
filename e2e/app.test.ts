import { test, expect } from '@playwright/test';
import path from 'node:path';
import { sendVbanWavs } from '../tests/helpers/send-vban';
import { listenToSse } from '../tests/helpers/sse-listen';

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

test.describe('GUI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('page title is Jimaku Translator', async ({ page }) => {
    await expect(page).toHaveTitle('Jimaku Translator');
  });

  test('status cards are visible', async ({ page }) => {
    await expect(page.locator('#vban-status')).toBeVisible();
    await expect(page.locator('#obs-status')).toBeVisible();
    await expect(page.locator('#whisper-status')).toBeVisible();
  });

  test('config form loads with values', async ({ page }) => {
    const vbanPort = page.locator('#cfg-vban-port');
    await expect(vbanPort).toBeVisible();
    // Port should be a valid number
    const portVal = await vbanPort.inputValue();
    expect(Number(portVal)).toBeGreaterThan(0);

    // All fields should have non-empty values
    await expect(page.locator('#cfg-obs-host')).not.toHaveValue('');
    await expect(page.locator('#cfg-obs-port')).not.toHaveValue('');
    await expect(page.locator('#cfg-whisper-variant')).toBeVisible();
    await expect(page.locator('#cfg-whisper-model-select')).toBeVisible();
    await expect(page.locator('#cfg-vad-threshold')).not.toHaveValue('');
  });

  test('config form has all sections', async ({ page }) => {
    await expect(page.locator('#cfg-obs-host')).toBeVisible();
    await expect(page.locator('#cfg-obs-password')).toBeVisible();
    await expect(page.locator('#cfg-obs-source-ja')).toBeVisible();
    await expect(page.locator('#cfg-obs-source-en')).toBeVisible();
    await expect(page.locator('#cfg-whisper-variant')).toBeVisible();
    await expect(page.locator('#cfg-whisper-model-select')).toBeVisible();
    await expect(page.locator('#cfg-subtitle-delay')).toBeVisible();
    await expect(page.locator('#cfg-subtitle-chars')).toBeVisible();
    await expect(page.locator('#cfg-vad-threshold')).toBeVisible();
    await expect(page.locator('#cfg-vad-min-speech')).toBeVisible();
    await expect(page.locator('#cfg-vad-max-speech')).toBeVisible();
  });

  test('save button exists and is enabled', async ({ page }) => {
    const btn = page.locator('#save-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test('log panel exists in DOM', async ({ page }) => {
    await expect(page.locator('#log-panel')).toBeAttached();
  });

  test('result panel shows waiting message', async ({ page }) => {
    await expect(page.locator('#result-panel .empty')).toHaveText('Waiting for speech...');
  });

  test('SSE connects and receives status', async ({ page }) => {
    // Wait for at least one status update (pipeline emits every 1s)
    await page.waitForFunction(() => {
      const el = document.getElementById('vban-status');
      return el && el.textContent !== '--';
    }, { timeout: 5000 });

    const vbanText = await page.locator('#vban-status').textContent();
    expect(vbanText).not.toBe('--');
  });
});

test.describe('API', () => {
  test('GET /api/status returns JSON', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('vban');
    expect(data).toHaveProperty('obs');
    expect(data).toHaveProperty('whisper');
  });

  test('GET /api/config returns JSON', async ({ request }) => {
    const res = await request.get('/api/config');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('vban.port');
    expect(data).toHaveProperty('obs.host');
    expect(data).toHaveProperty('whisper.server');
    expect(data).toHaveProperty('subtitle.clear_delay');
    expect(data).toHaveProperty('vad.threshold');
  });

  test('POST /api/config round-trip preserves values', async ({ request }) => {
    const before = await (await request.get('/api/config')).json();
    const post = await request.post('/api/config', { data: before });
    expect(post.ok()).toBe(true);
    const after = await (await request.get('/api/config')).json();
    expect(after.vban.port).toBe(before.vban.port);
    expect(after.obs.host).toBe(before.obs.host);
    expect(after.vad.threshold).toBe(before.vad.threshold);
    expect(after.audio.rms_gate_db).toBe(before.audio.rms_gate_db);
  });

  test('GET /api/obs/sources returns sources array when disconnected', async ({ request }) => {
    const res = await request.get('/api/obs/sources');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.sources)).toBe(true);
  });

  test('GET /api/whisper/variants returns variants + installed map', async ({ request }) => {
    const res = await request.get('/api/whisper/variants');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.variants)).toBe(true);
    expect(data.variants.length).toBeGreaterThan(0);
    expect(data).toHaveProperty('installed');
    expect(data).toHaveProperty('recommended');
    for (const v of data.variants) {
      expect(Object.keys(data.installed)).toContain(v.id);
    }
  });

  test('GET /api/whisper/models returns models + installed map', async ({ request }) => {
    const res = await request.get('/api/whisper/models');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThan(0);
    const installedKeys = Object.keys(data.installed);
    for (const m of data.models) {
      expect(installedKeys).toContain(m.id);
    }
  });

  test('POST /api/whisper/download-binary missing variant returns 400', async ({ request }) => {
    const res = await request.post('/api/whisper/download-binary', { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/whisper/download-cancel with invalid id returns 404', async ({ request }) => {
    const res = await request.post('/api/whisper/download-cancel', { data: { id: 'nonexistent-xyz' } });
    expect(res.status()).toBe(404);
  });

  test('POST /api/capture with oversized duration_ms is clamped (no hang)', async ({ request }) => {
    // VBAN not arriving in test env → fails fast (~2s watchdog). Without
    // clamping, 50000ms would push capture far beyond Playwright's 30s timeout.
    const start = Date.now();
    const res = await request.post('/api/capture', { data: { duration_ms: 50000 } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10000);
    // Either 200 (audio) or 400 (no VBAN) — both prove no hang
    expect([200, 400]).toContain(res.status());
  });

  test('POST /api/config rejects oversized body', async ({ request }) => {
    const huge = 'x'.repeat(100 * 1024);
    let cut = false;
    let status = 0;
    try {
      const res = await request.post('/api/config', {
        headers: { 'Content-Type': 'application/json' },
        data: { junk: huge },
      });
      status = res.status();
    } catch {
      cut = true;
    }
    expect(cut || (status >= 400 && status < 500)).toBe(true);
  });

  test('GET /api/events SSE delivers initial status', async ({ page }) => {
    await page.goto('/');
    const status = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      const es = new EventSource('/api/events');
      const timer = setTimeout(() => { es.close(); reject(new Error('timeout')); }, 5000);
      es.addEventListener('status', (ev: MessageEvent) => {
        clearTimeout(timer);
        es.close();
        resolve(JSON.parse(ev.data));
      });
    }));
    expect(status).toHaveProperty('vban');
    expect(status).toHaveProperty('obs');
    expect(status).toHaveProperty('whisper');
  });

  test('POST /api/config with invalid data returns 400', async ({ request }) => {
    const res = await request.post('/api/config', {
      data: {
        vban: { port: -1, stream_name: '' },
        obs: { host: '', port: 4455, password: '', source_ja: 'ja', source_en: 'en', closed_caption: false, cc_language: 'ja' },
        whisper: { server: 'http://localhost:8080', binary: '', model: '', binary_variant: '', model_name: '' },
        subtitle: { clear_delay: 3, chars_per_line: 0 },
        vad: { threshold: 0.5, min_speech_ms: 500, max_speech_ms: 10000 },
        audio: { rms_gate_db: -60, normalize_target_dbfs: -6, adaptive_gate_enabled: false, adaptive_gate_margin_db: 6, adaptive_gate_window_sec: 10 },
        ui: { language: '' },
      },
    });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBe(400);
  });
});

test.describe('UI behavior', () => {
  test.beforeEach(async ({ page }) => {
    // wipe-once-then-reload (not addInitScript) so persistence tests can survive their own reloads
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('config wrapper collapse persists across reload', async ({ page }) => {
    const wrapper = page.locator('#config-wrapper');
    await expect(wrapper).not.toHaveClass(/collapsed/);
    await page.locator('#config-toggle').click();
    await expect(wrapper).toHaveClass(/collapsed/);
    await page.reload();
    await expect(page.locator('#config-wrapper')).toHaveClass(/collapsed/);
  });

  test('language switch via config persists and translates UI', async ({ page, request }) => {
    const original = await (await request.get('/api/config')).json();
    try {
      await request.post('/api/config', { data: { ...original, ui: { ...original.ui, language: 'ja' } } });
      await page.reload();
      const text = await page.locator('#config-toggle').textContent();
      expect(text?.trim()).toBe('設定');
    } finally {
      await request.post('/api/config', { data: original });
    }
  });

  test('VAD threshold slider updates value display', async ({ page }) => {
    const slider = page.locator('#cfg-vad-threshold');
    await slider.fill('0.7');
    await slider.dispatchEvent('input');
    await expect(page.locator('#cfg-vad-threshold-value')).toHaveText(/0\.70?/);
  });

  test('Audio gate slider updates value display', async ({ page }) => {
    const slider = page.locator('#cfg-audio-gate');
    await slider.fill('-45');
    await slider.dispatchEvent('input');
    await expect(page.locator('#cfg-audio-gate-value')).toHaveText('-45');
  });

  test('Result panel is no longer fixed at 125px', async ({ page }) => {
    const height = await page.locator('#result-panel').evaluate((el) => {
      return getComputedStyle(el).maxHeight;
    });
    expect(height).not.toBe('125px');
    expect(height).not.toBe('none');
  });

  test('Whisper hint is visible while whisper is unreachable', async ({ page }) => {
    // E2E env has no managed whisper-server bound → reachable: false from boot
    await page.waitForFunction(() => {
      const el = document.getElementById('whisper-status');
      return el && el.textContent !== '--';
    }, { timeout: 5000 });
    const hint = page.locator('#whisper-hint');
    await expect(hint).toBeVisible();
    // Test env has empty whisper.binary → reason='unreachable'. Verify the
    // i18n-mapped string is rendered (covers reason → text mapping).
    await expect(hint).toHaveText(/unreachable|到達できません/);
  });

  test('Whisper hint click expands collapsed config + whisper section', async ({ page }) => {
    // Force everything collapsed first
    await page.evaluate(() => {
      document.getElementById('config-wrapper')!.classList.add('collapsed');
      document.querySelector('.config-section[data-section="whisper"]')!.classList.add('collapsed');
    });
    await page.locator('#whisper-hint').click();
    await expect(page.locator('#config-wrapper')).not.toHaveClass(/collapsed/);
    await expect(page.locator('.config-section[data-section="whisper"]')).not.toHaveClass(/collapsed/);
  });

  test('Adaptive Gate Margin disabled state follows checkbox', async ({ page }) => {
    const gate = page.locator('#cfg-audio-adaptive-gate');
    const margin = page.locator('#cfg-audio-adaptive-margin');
    await gate.evaluate((el: HTMLInputElement) => { el.checked = false; el.dispatchEvent(new Event('change')); });
    await expect(margin).toBeDisabled();
    await gate.evaluate((el: HTMLInputElement) => { el.checked = true; el.dispatchEvent(new Event('change')); });
    await expect(margin).toBeEnabled();
  });

  test('Collapse state recovers from corrupted localStorage', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('jimaku-translator-collapsed', '{not json'));
    await page.reload();
    // Should not throw and config-wrapper should default to expanded
    await expect(page.locator('#config-wrapper')).not.toHaveClass(/collapsed/);
  });

});

test.describe('API edge cases', () => {
  test('POST /api/config rejects vban port 0', async ({ request }) => {
    const before = await (await request.get('/api/config')).json();
    const res = await request.post('/api/config', {
      data: { ...before, vban: { ...before.vban, port: 0 } },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/config rejects vban port 65536', async ({ request }) => {
    const before = await (await request.get('/api/config')).json();
    const res = await request.post('/api/config', {
      data: { ...before, vban: { ...before.vban, port: 65536 } },
    });
    expect(res.status()).toBe(400);
  });

  test('Save with CC enabled + no source shows warning toast', async ({ page, request }) => {
    const original = await (await request.get('/api/config')).json();
    try {
      await page.goto('/');
      // Wait for the config form to have been populated from /api/config,
      // otherwise our overrides race the async fetch and get clobbered.
      await expect(page.locator('#cfg-obs-host')).not.toHaveValue('');
      await page.evaluate(() => {
        (document.getElementById('cfg-obs-cc') as HTMLInputElement).checked = true;
        (document.getElementById('cfg-obs-source-ja') as HTMLSelectElement).value = '';
        (document.getElementById('cfg-obs-source-en') as HTMLSelectElement).value = '';
      });
      await page.locator('#save-btn').click();
      const toast = page.locator('#toast');
      // Toast is opacity-toggled (always in DOM), so wait on the .show class.
      await expect(toast).toHaveClass(/show/, { timeout: 3000 });
      const text = (await toast.textContent()) ?? '';
      expect(text).toMatch(/Closed Caption|クローズドキャプション/);
    } finally {
      await request.post('/api/config', { data: original });
    }
  });

  // Boundary matrix for invalid config fields. Each row exercises one
  // out-of-range value while leaving the rest of the payload valid.
  const invalidConfigCases: Array<{ name: string; mutate: (cfg: any) => void }> = [
    { name: 'obs.port = 0',                  mutate: (c) => { c.obs.port = 0; } },
    { name: 'obs.port = 65536',              mutate: (c) => { c.obs.port = 65536; } },
    { name: 'vad.threshold = -0.1',          mutate: (c) => { c.vad.threshold = -0.1; } },
    { name: 'vad.threshold = 1.1',           mutate: (c) => { c.vad.threshold = 1.1; } },
    { name: 'subtitle.clear_delay = -1',     mutate: (c) => { c.subtitle.clear_delay = -1; } },
    { name: 'subtitle.chars_per_line = -1',  mutate: (c) => { c.subtitle.chars_per_line = -1; } },
  ];
  for (const { name, mutate } of invalidConfigCases) {
    test(`POST /api/config rejects ${name}`, async ({ request }) => {
      const before = await (await request.get('/api/config')).json();
      mutate(before);
      const res = await request.post('/api/config', { data: before });
      expect(res.status()).toBe(400);
    });
  }

  test('SSE replays buffered log events on connect (synchronous burst)', async ({ page }) => {
    await page.goto('/');
    // Replayed logs are written into the SSE stream *before* clients.add(res)
    // (handleSSE), so they arrive in the first chunk — well under 200ms. Live
    // log broadcasts are event-driven (pipeline.emit('log',...) on VBAN/VAD/
    // OBS lifecycle events); after startup the stream is quiet and no periodic
    // log source exists, so the 200ms window isolates the replay path. Status
    // ticks at 300ms cadence are filtered by event name and do not collide.
    const logs = await page.evaluate(() => new Promise<string[]>((resolve) => {
      const collected: string[] = [];
      const es = new EventSource('/api/events');
      es.addEventListener('log', (ev: MessageEvent) => {
        try { collected.push(JSON.parse(ev.data).message); } catch {}
      });
      setTimeout(() => { es.close(); resolve(collected); }, 200);
    }));
    expect(logs.length).toBeGreaterThan(0);
  });

  test('VAD debug overlay toggles via [ui] show_vad_debug', async ({ page, request }) => {
    const original = await (await request.get('/api/config')).json();
    try {
      await request.post('/api/config', { data: { ...original, ui: { ...original.ui, show_vad_debug: true } } });
      await page.goto('/');
      // showVadDebug is applied from the next status tick (pipeline emits every 1s)
      await expect(page.locator('.vad-debug-only').first()).toBeVisible({ timeout: 3000 });
    } finally {
      await request.post('/api/config', { data: original });
    }
  });

  test('Download binary button reflects installed status from API', async ({ page, request }) => {
    const variants = await (await request.get('/api/whisper/variants')).json();
    await page.goto('/');
    await page.waitForFunction(() => {
      const btn = document.getElementById('download-binary-btn') as HTMLButtonElement;
      return btn && btn.textContent !== '';
    });
    const sel = await page.locator('#cfg-whisper-variant').inputValue();
    const installed = !!variants.installed[sel];
    const btn = page.locator('#download-binary-btn');
    if (installed) await expect(btn).toBeDisabled();
    else await expect(btn).toBeEnabled();
  });
});

// Gated behind JT_E2E_RECOGNITION because it needs an installed whisper.cpp
// binary + speech-capable model. Fixtures generated via `say -v Kyoko`.
test.describe('Recognition E2E', () => {
  test.skip(!process.env.JT_E2E_RECOGNITION, 'set JT_E2E_RECOGNITION=1 to run');

  const FIXTURES = [
    { file: 'jp-1.wav', expected: '今日はいい天気ですね' },
    { file: 'jp-2.wav', expected: 'コーヒーをお願いします' },
    { file: 'jp-3.wav', expected: 'ありがとうございます' },
    { file: 'jp-4.wav', expected: 'おはようございます' },
  ];

  test('VBAN → VAD → Whisper produces recognition for fixture WAVs', async ({ request }) => {
    test.setTimeout(120_000);

    const variants = await (await request.get('/api/whisper/variants')).json();
    const models = await (await request.get('/api/whisper/models')).json();
    const installedBinary = Object.entries(variants.installed as Record<string, string | null>)
      .find(([, p]) => p);
    const preferredModel = ['medium', 'large-v3', 'small', 'base']
      .map((id) => [id, (models.installed as Record<string, string | null>)[id]] as const)
      .find(([, p]) => p);
    test.skip(
      !installedBinary || !preferredModel,
      'requires installed whisper binary + medium/large/small/base model',
    );

    const cfg = await (await request.get('/api/config')).json();
    cfg.whisper.binary = installedBinary![1];
    cfg.whisper.binary_variant = installedBinary![0];
    cfg.whisper.model = preferredModel![1];
    cfg.whisper.model_name = preferredModel![0];
    const saveRes = await request.post('/api/config', { data: cfg });
    expect(saveRes.ok()).toBe(true);

    type StatusEvent = { whisper?: { reachable?: boolean }; lastResult?: { ja?: string; en?: string; timestamp?: number } };
    const sse = await listenToSse();
    try {
      await sse.waitFor((e) => e.event === 'status' && !!(e.data as StatusEvent).whisper?.reachable, 30_000);

      const fixturesDir = path.resolve(__dirname, '..', 'tests', 'fixtures');
      const results: Array<{ expected: string; ja: string; en: string; latencyMs: number }> = [];

      for (const { file, expected } of FIXTURES) {
        const before = sse.events.reduce((max, e) => {
          if (e.event !== 'status') return max;
          const ts = (e.data as StatusEvent).lastResult?.timestamp ?? 0;
          return ts > max ? ts : max;
        }, 0);

        const sendStart = Date.now();
        const sendPromise = sendVbanWavs([path.join(fixturesDir, file)]);

        try {
          const ev = await sse.waitFor((e) => {
            if (e.event !== 'status') return false;
            const r = (e.data as StatusEvent).lastResult;
            return !!r && (r.timestamp ?? 0) > before && !!r.ja && r.ja.trim().length > 0;
          }, 30_000);
          const r = (ev.data as StatusEvent).lastResult!;
          results.push({ expected, ja: r.ja!, en: r.en ?? '', latencyMs: Date.now() - sendStart });
        } finally {
          // Always drain the sender — otherwise a waitFor timeout leaves UDP
          // streaming into the next iteration and contaminates `before`.
          await sendPromise.catch(() => { /* sender errors are non-fatal */ });
        }
      }

      for (const r of results) {
        const dist = levenshtein(r.ja, r.expected);
        const ratio = dist / r.expected.length;
        // eslint-disable-next-line no-console
        console.log(`[recog] expected="${r.expected}" got="${r.ja}" en="${r.en}" lev=${dist} ratio=${ratio.toFixed(2)} latency=${r.latencyMs}ms`);
        expect(r.ja.length).toBeGreaterThan(0);
        expect(r.en.length).toBeGreaterThan(0);
        expect(r.en).not.toContain('\n');
        expect(r.latencyMs).toBeLessThan(15_000);
        // Fixture set is fixed (4× Kyoko TTS); manually verified medium model
        // hits Levenshtein distance ≤ 1 on every entry. 0.3 leaves headroom for
        // a single substitution while still failing on a real regression.
        expect(ratio).toBeLessThan(0.3);
      }
    } finally {
      sse.close();
    }
  });
});
