import { test, expect } from '@playwright/test';

test.describe('GUI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('page title is jimaku-translator', async ({ page }) => {
    await expect(page).toHaveTitle('jimaku-translator');
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
    await expect(page.locator('#cfg-whisper-server')).not.toHaveValue('');
    await expect(page.locator('#cfg-vad-threshold')).not.toHaveValue('');
  });

  test('config form has all sections', async ({ page }) => {
    await expect(page.locator('#cfg-obs-host')).toBeVisible();
    await expect(page.locator('#cfg-obs-password')).toBeVisible();
    await expect(page.locator('#cfg-obs-source-ja')).toBeVisible();
    await expect(page.locator('#cfg-obs-source-en')).toBeVisible();
    await expect(page.locator('#cfg-whisper-server')).toBeVisible();
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

  test('log panel exists', async ({ page }) => {
    await expect(page.locator('#log-panel')).toBeVisible();
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
