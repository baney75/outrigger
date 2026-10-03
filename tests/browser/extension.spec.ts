import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { fixtureServer } from './fixture';

let context: BrowserContext, page: Page, worker: Worker;
let server: Awaited<ReturnType<typeof fixtureServer>>;
let extensionId: string;
let permissionFixture: string | undefined;

test.beforeEach(async ({}, testInfo) => {
  server = await fixtureServer();
  let extensionPath = path.resolve('dist');
  if (testInfo.title.startsWith('notification')) {
    // Exercise the real notifications API after permission is granted. Headless Chromium has no permission prompt UI.
    permissionFixture = await mkdtemp(path.join(os.tmpdir(), 'outrigger-permissions-'));
    await cp(extensionPath, permissionFixture, { recursive: true });
    const manifest = JSON.parse(
      await readFile(path.join(permissionFixture, 'manifest.json'), 'utf8'),
    );
    manifest.permissions.push('notifications');
    manifest.optional_permissions = [];
    await writeFile(path.join(permissionFixture, 'manifest.json'), JSON.stringify(manifest));
    extensionPath = permissionFixture;
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 380, height: 760 },
    colorScheme: 'dark',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).hostname;
  page = await context.newPage();
});
test.afterEach(async () => {
  await context?.close();
  await server?.close();
  if (permissionFixture) {
    await rm(permissionFixture, { recursive: true, force: true });
    permissionFixture = undefined;
  }
});

async function boot() {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const paired = await page.evaluate(
    async (base) =>
      chrome.runtime.sendMessage({ type: 'pair', url: `${base}/pair#token=fixture-pairing` }),
    server.base,
  );
  expect(paired.ok).toBe(true);
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'watch', threadId: 'thread-a', value: true });
    await chrome.runtime.sendMessage({
      type: 'theme',
      value: { id: 't3-code', appearance: 'dark' },
    });
  });
  await expect(page.getByRole('heading', { name: /Sessions/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Refine the pricing page.*Ready/ })).toBeVisible();
}
async function chat() {
  await page
    .getByRole('button', {
      name: /Refine the pricing page.*Ready|Refine the pricing page.*Waiting/,
    })
    .click();
  await expect(page.getByRole('log')).toContainText('The layout is ready.');
}
async function checkFits() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
}

test('the packaged first-run screen is useful and rejects insecure pairing', async () => {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('heading', { name: /Same session/ })).toBeVisible();
  expect(
    await worker.evaluate(async () => ({
      behavior: await chrome.sidePanel.getPanelBehavior(),
      action: chrome.action.onClicked.hasListeners(),
    })),
  ).toEqual({ behavior: { openPanelOnActionClick: false }, action: true });
  await page.getByLabel('T3 Code pairing link').fill('http://untrusted.example/pair#token=secret');
  await page.getByRole('button', { name: 'Connect to T3 Code', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/HTTPS|loopback|secure/i);
  expect(server.commands).toHaveLength(0);
  await checkFits();
});

test('continues the chosen session, isolates drafts, and survives a panel reload', async () => {
  await boot();
  await page.keyboard.press('/');
  await expect(page.getByRole('textbox', { name: 'Search sessions' })).toBeFocused();
  await chat();
  await page.getByRole('textbox', { name: 'Message this session' }).fill('Draft for pricing');
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
  await page.getByRole('button', { name: /Make the docs easier to follow.*Ready/ }).click();
  await expect(page.getByRole('textbox', { name: 'Message this session' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Message this session' }).fill('Draft for docs');
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
  await chat();
  await expect(page.getByRole('textbox', { name: 'Message this session' })).toHaveValue(
    'Draft for pricing',
  );
  await page.reload();
  await chat();
  await expect(page.getByRole('textbox', { name: 'Message this session' })).toHaveValue(
    'Draft for pricing',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Continuing in the same session.');
  await expect(page.getByRole('textbox', { name: 'Message this session' })).toHaveValue('');
  expect(server.commands.filter((c) => c.type === 'thread.turn.start')).toMatchObject([
    { threadId: 'thread-a', message: { text: 'Draft for pricing' } },
  ]);
});

test('lost acknowledgements never replay or erase the saved draft', async () => {
  await boot();
  await chat();
  server.loseNextAcknowledgement();
  await page.getByRole('textbox', { name: 'Message this session' }).fill('Send this once');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Check delivery before resending.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.reload();
  await chat();
  await expect(page.getByText('Check delivery before resending.', { exact: true })).toBeVisible();
  expect(server.commands.filter((c) => c.type === 'thread.turn.start')).toHaveLength(1);
});

test('answers a real-shaped T3 question and removes the resolved request', async () => {
  await boot();
  server.question();
  await chat();
  await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled();
  await page.getByLabel('Annual billing', { exact: false }).check();
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(
    page.getByText('Which price should visitors see first?', { exact: true }),
  ).toHaveCount(0);
  expect(server.commands).toMatchObject([
    {
      type: 'thread.user-input.respond',
      threadId: 'thread-a',
      requestId: 'question-1',
      answers: { billing: 'annual' },
    },
  ]);
});

test('offline drafts stay local and recover after a server interruption', async () => {
  await boot();
  await chat();
  server.setOffline(true);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Message this session' }).fill('Keep this while offline');
  await page.reload();
  await expect(page.getByText(/disconnected|Reconnecting to T3 Code/).first()).toBeVisible();
  server.setOffline(false);
  await expect(page.getByRole('button', { name: /Refine the pricing page.*Ready/ })).toBeVisible({
    timeout: 20000,
  });
  await chat();
  await expect(page.getByRole('textbox', { name: 'Message this session' })).toHaveValue(
    'Keep this while offline',
  );
  expect(server.commands).toHaveLength(0);
});

test('imports exact custom theme colors and contains hostile message content', async () => {
  await boot();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'custom.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        id: 'aubergine',
        name: 'Aubergine',
        appearance: 'dark',
        colors: { canvas: '#201820', accent: '#d89bbb', text: '#fff1f8' },
      }),
    ),
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
      ),
    )
    .toBe('#201820');
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
      ),
    )
    .toBe('#201820');
  await chat();
  server.maliciousMessage();
  await expect(page.getByText('[Image · open in T3 Code]', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'pwned' in globalThis)).toBe(false);
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  expect(await page.locator('img[src^="https:"]').count()).toBe(0);
});

test('renders light, dark, custom, narrow and short layouts with keyboard access', async () => {
  await boot();
  server.question();
  await chat();
  await mkdir('docs/images', { recursive: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'docs/images/conversation-dark.png' });
  await checkFits();
  await page.setViewportSize({ width: 320, height: 500 });
  await checkFits();
  await expect(page.getByRole('button', { name: /Open composer/ })).toBeInViewport();
  await page.screenshot({ path: 'docs/images/conversation-compact.png' });
  await page.getByRole('button', { name: /Open composer/ }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 380, height: 760 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'docs/images/conversation-light.png' });
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
  await page.screenshot({ path: 'docs/images/sessions.png' });
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  expect(violations).toEqual([]);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
});

test('clears credentials and drafts on disconnect without leaking them into the UI', async () => {
  await boot();
  await chat();
  await page.getByRole('textbox', { name: 'Message this session' }).fill('private draft');
  const snapshot = await page.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'snapshot' }),
  );
  expect(JSON.stringify(snapshot)).not.toContain('fixture-bearer');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect and clear local drafts' }).click();
  await expect(page.getByRole('heading', { name: /Same session/ })).toBeVisible();
  const keys = await worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
  expect(keys).not.toContain('connection');
  expect(keys.some((key) => key.startsWith('draft:'))).toBe(false);
});

test('shows exact approval context and transmits only the chosen decision', async () => {
  await boot();
  server.approval();
  await chat();
  await expect(page.locator('.approval-command')).toHaveText('npm test');
  await expect(page.locator('.request-cwd')).toContainText('/example/acme');
  await expect(page.getByText('Runs on your T3 server.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect.poll(() => server.commands.length).toBe(1);
  expect(server.commands).toMatchObject([
    {
      type: 'thread.approval.respond',
      decision: 'decline',
      requestId: 'approval-1',
      threadId: 'thread-a',
    },
  ]);
});

test('blocks approvals with missing execution context', async () => {
  await boot();
  server.approval('thread-a', false);
  await chat();
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review in T3 Code', exact: false })).toBeVisible();
  expect(server.commands).toHaveLength(0);
});

test('imported light and dark variants survive appearance switching', async () => {
  await boot();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'dual.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        id: 'dual',
        name: 'Dual',
        appearance: 'dark',
        colors: { canvas: '#151019' },
        variants: { light: { canvas: '#f8f3fa' }, dark: { canvas: '#151019' } },
      }),
    ),
  });
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
      ),
    )
    .toBe('#f8f3fa');
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
      ),
    )
    .toBe('#151019');
});

test('notification badges follow watch changes and remote resolution immediately', async () => {
  await boot();
  server.question();
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  await page
    .getByRole('button', { name: 'Stop watching Refine the pricing page', exact: true })
    .click();
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await page.getByRole('button', { name: 'Watch Refine the pricing page', exact: true }).click();
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  expect(await worker.evaluate(() => chrome.notifications.getAll())).toEqual({});
  await page
    .getByRole('button', { name: 'Silent mode is on. Enable notifications', exact: true })
    .click();
  server.resolve();
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  server.question('thread-a', 'question-2');
  await expect
    .poll(async () => Object.keys(await worker.evaluate(() => chrome.notifications.getAll())))
    .toEqual(['attention:thread-a']);
  server.resolve('thread-a', 'question-2');
  await expect
    .poll(async () => Object.keys(await worker.evaluate(() => chrome.notifications.getAll())))
    .toEqual([]);
  server.question('thread-a', 'question-3');
  await expect
    .poll(async () => Object.keys(await worker.evaluate(() => chrome.notifications.getAll())))
    .toEqual(['attention:thread-a']);
  await page
    .getByRole('button', { name: 'Notifications are on. Enable silent mode', exact: true })
    .click();
  await expect
    .poll(async () => Object.keys(await worker.evaluate(() => chrome.notifications.getAll())))
    .toEqual([]);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Silent mode is on. Enable notifications', exact: true }),
  ).toBeVisible();
});

test('worker restart resumes the connection and preserves a per-session draft', async () => {
  await boot();
  await chat();
  await page
    .getByRole('textbox', { name: 'Message this session' })
    .fill('Survive a worker restart');
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  await chat();
  await expect(page.getByRole('textbox', { name: 'Message this session' })).toHaveValue(
    'Survive a worker restart',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Continuing in the same session.');
  expect(server.commands).toHaveLength(1);
});

test('a notification link opens its intended conversation', async () => {
  await boot();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html?thread=thread-b`);
  await expect(
    page.getByRole('heading', { name: 'Make the docs easier to follow', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('log')).toContainText('grouped the setup steps');
});

test('a receipt cannot erase a newer draft saved by another view', async () => {
  await boot();
  await chat();
  await page.getByRole('textbox', { name: 'Message this session' }).fill('First message');
  const second = await context.newPage();
  await second.goto(`chrome-extension://${extensionId}/sidepanel.html?thread=thread-a`);
  await expect(second.getByRole('textbox', { name: 'Message this session' })).toHaveValue(
    'First message',
  );
  const release = server.holdNextAcknowledgement();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => server.commands.length).toBe(1);
  // A delayed save from the other view can arrive while the network receipt is outstanding.
  await second.evaluate(async () =>
    chrome.runtime.sendMessage({
      type: 'draft',
      key: 'draft:["env-demo","thread-a"]',
      value: { text: 'Newer draft from the other panel', revision: crypto.randomUUID() },
    }),
  );
  release();
  await expect(page.getByRole('textbox', { name: 'Message this session' })).toHaveValue(
    'Newer draft from the other panel',
  );
  await second.reload();
  await second.getByRole('button', { name: /Refine the pricing page.*Ready/ }).click();
  await expect(second.getByRole('textbox', { name: 'Message this session' })).toHaveValue(
    'Newer draft from the other panel',
  );
  expect(server.commands).toHaveLength(1);
});

test('lost response receipts remain locked across panel and worker restart', async () => {
  await boot();
  server.question();
  await chat();
  server.loseResponseAcknowledgement();
  await page.getByLabel('Annual billing', { exact: false }).check();
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(
    page.getByText('Response delivery is uncertain. Review this request in T3 Code.', {
      exact: true,
    }),
  ).toBeVisible();
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  await chat();
  await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Review in T3 Code/ })).toBeVisible();
  expect(server.commands).toHaveLength(1);
  server.resolve();
  await expect(
    page.getByText('Which price should visitors see first?', { exact: true }),
  ).toHaveCount(0);
});

test('draft revisions reject stale sends after another view edits', async () => {
  await boot();
  await chat();
  await page.getByRole('textbox', { name: 'Message this session' }).fill('Latest draft');
  const result = await page.evaluate(async () =>
    chrome.runtime.sendMessage({
      type: 'draft',
      key: 'draft:["env-demo","thread-a"]',
      value: { text: 'Stale message', revision: crypto.randomUUID(), uncertain: true },
      expectedRevision: crypto.randomUUID(),
    }),
  );
  expect(result.value.applied).toBe(false);
  expect(result.value.value.text).toBe('Latest draft');
  expect(server.commands).toHaveLength(0);
});
