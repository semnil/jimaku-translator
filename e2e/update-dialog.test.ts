import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';

const packageVersion = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }).version;

test.use({ locale: 'en-US' });

// Every page here reads ui.language as '' from GET /api/config and follows the en-US locale.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const config = await response.json() as { ui: { language: string } };
    config.ui.language = '';
    return route.fulfill({ response, json: config });
  });
});

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface FakeUpdate {
  status?: Record<string, unknown>;
  check?: (body: Record<string, unknown>) => { status?: number; body: unknown };
  install?: (body: Record<string, unknown>) => { status?: number; body: unknown };
  settings?: (body: Record<string, unknown>) => { status?: number; body: unknown };
}

/** Answers /api/update/* as the packaged app would; records the POST bodies. */
async function fakePackagedApp(page: Page, fake: FakeUpdate) {
  const posted: Record<string, Array<Record<string, unknown>>> = { check: [], install: [], settings: [] };
  await page.route('**/api/update/status', (route) => fulfillJson(route, {
    current: '1.1.1', supported: true, launch_check: true, launch_pending: false, ...fake.status,
  }));
  for (const name of ['check', 'install', 'settings'] as const) {
    await page.route(`**/api/update/${name}`, (route) => {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      posted[name]!.push(body);
      const answer = fake[name]?.(body) ?? { body: {} };
      return fulfillJson(route, answer.body, answer.status);
    });
  }
  return posted;
}

test.describe('App settings dialog (CLI server)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows the running version and that updates need the installed app', async ({ page }) => {
    await page.getByRole('button', { name: 'App settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'App settings' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#settings-version')).toHaveText(`Jimaku Translator ${packageVersion}`);
    await expect(dialog.getByText('Available in the installed app only.')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Check at launch' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  test('moves focus into the dialog, keeps it there and returns it on Escape', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'App settings' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const close = page.getByRole('button', { name: 'Close' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('makes the page behind the dialog inert', async ({ page }) => {
    await page.getByRole('button', { name: 'App settings' }).click();
    await expect(page.locator('main')).toHaveJSProperty('inert', true);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('main')).toHaveJSProperty('inert', false);
  });

  test('closes on a press on the backdrop', async ({ page }) => {
    await page.getByRole('button', { name: 'App settings' }).click();
    await page.mouse.click(5, 5);
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test.describe('Update flow (packaged app answers faked)', () => {
  test('the launch check asks to update and an accepted update downloads and restarts', async ({ page }) => {
    const posted = await fakePackagedApp(page, {
      status: { launch_pending: true },
      check: () => ({ body: { available: true, version: '9.9.9' } }),
      install: () => ({ body: { restarting: true } }),
    });
    const confirmText = new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      });
    });
    await page.goto('/');
    expect(await confirmText).toBe('Version 9.9.9 is available. Update now?\n\nThe app restarts after the update. Subtitles stop until it has restarted.');
    await expect(page.locator('#update-banner')).toHaveText(/Downloading update… the app will restart/);
    expect(posted.check).toEqual([{ launch: true }]);
    expect(posted.install).toEqual([{ version: '9.9.9' }]);
    await expect(page.getByRole('button', { name: 'App settings' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('no launch check runs while it is not pending', async ({ page }) => {
    const posted = await fakePackagedApp(page, { check: () => ({ body: { available: true, version: '9.9.9' } }) });
    let asked = false;
    page.on('dialog', (dialog) => { asked = true; void dialog.dismiss(); });
    const statusLoaded = page.waitForResponse('**/api/update/status');
    await page.goto('/');
    await statusLoaded;
    await page.getByRole('button', { name: 'App settings' }).click();
    expect(posted.check).toEqual([]);
    expect(asked).toBe(false);
  });

  test('a declined update is reported in the dialog and nothing is installed', async ({ page }) => {
    const posted = await fakePackagedApp(page, { check: () => ({ body: { available: true, version: '9.9.9' } }) });
    page.on('dialog', (dialog) => { void dialog.dismiss(); });
    await page.goto('/');
    await page.getByRole('button', { name: 'App settings' }).click();
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.locator('#settings-update-note')).toHaveText('Version 9.9.9 is available.');
    await expect(page.getByRole('button', { name: 'Check now' })).toBeFocused();
    expect(posted.check).toEqual([{}]);
    expect(posted.install).toEqual([]);
  });

  test('"Check now" reports an app that is up to date', async ({ page }) => {
    await fakePackagedApp(page, { check: () => ({ body: { available: false } }) });
    await page.goto('/');
    await page.getByRole('button', { name: 'App settings' }).click();
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.locator('#settings-update-note')).toHaveText('Already up to date.');
  });

  test('"Check now" reports a failed check', async ({ page }) => {
    await fakePackagedApp(page, { check: () => ({ status: 502, body: { error: 'HttpError: 404' } }) });
    await page.goto('/');
    await page.getByRole('button', { name: 'App settings' }).click();
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.locator('#settings-update-note')).toHaveText('Update check failed.');
  });

  test('a failed download says what failed and gives the settings button back', async ({ page }) => {
    await fakePackagedApp(page, {
      check: () => ({ body: { available: true, version: '9.9.9' } }),
      install: () => ({ status: 500, body: { error: 'sha512 checksum mismatch' } }),
    });
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await page.goto('/');
    await page.getByRole('button', { name: 'App settings' }).click();
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.locator('#update-banner')).toContainText('The update could not be downloaded and installed: sha512 checksum mismatch');
    await expect(page.getByRole('button', { name: 'App settings' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a restart that fails after the download is reported', async ({ page }) => {
    await fakePackagedApp(page, {});
    await page.route('**/api/events', (route) => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: update-error\ndata: {"message":"Squirrel.Mac: code signature invalid"}\n\n',
    }));
    await page.goto('/');
    await expect(page.locator('#update-banner')).toContainText(
      'The update was downloaded, but the app could not restart to install it (Squirrel.Mac: code signature invalid). Quit the app and open it again.');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#update-banner')).toBeHidden();
    await expect(page.getByRole('button', { name: 'App settings' })).toBeFocused();
  });

  test('"Check at launch" is saved through the server', async ({ page }) => {
    const posted = await fakePackagedApp(page, { settings: (body) => ({ body: { launch_check: body.launch_check } }) });
    await page.goto('/');
    await page.getByRole('button', { name: 'App settings' }).click();
    const launch = page.getByRole('checkbox', { name: 'Check at launch' });
    await expect(launch).toBeChecked();
    await launch.click();
    await expect(launch).not.toBeChecked();
    await expect(launch).toBeFocused();
    expect(posted.settings).toEqual([{ launch_check: false }]);
  });

  test('a failed save keeps the previous value and says so', async ({ page }) => {
    await fakePackagedApp(page, { settings: () => ({ status: 500, body: { error: 'EACCES' } }) });
    await page.goto('/');
    await page.getByRole('button', { name: 'App settings' }).click();
    const launch = page.getByRole('checkbox', { name: 'Check at launch' });
    await launch.click();
    await expect(page.locator('#settings-update-note')).toHaveText('The setting could not be saved.');
    await expect(launch).toBeChecked();
  });
});
