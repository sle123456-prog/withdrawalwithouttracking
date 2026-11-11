import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extension = path.join(root, 'extension');
const profile = await mkdtemp(path.join(os.tmpdir(), 'relay-beta-browser-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  acceptDownloads: true,
});
const errors = [];
try {
  // All external traffic is mocked: this test never touches a funded chain.
  await context.route('https://**/*', async (route) => {
    const request = route.request();
    let payload;
    try { payload = request.postDataJSON(); } catch {}
    if (!payload) return route.abort();
    const respond = (item) => {
      const values = { eth_chainId: '0x1', eth_getBalance: '0x0', eth_blockNumber: '0x1000000',
        eth_gasPrice: '0x3b9aca00', eth_maxPriorityFeePerGas: '0x3b9aca00', eth_getLogs: [] };
      return { jsonrpc: '2.0', id: item.id, result: values[item.method] ?? null };
    };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.isArray(payload) ? payload.map(respond) : respond(payload)) });
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const appUrl = `chrome-extension://${id}/app.html`;
  await page.goto(appUrl);
  await page.locator('#chain option').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('#mixMode').isChecked(), false);
  await page.locator('#mixMode').check();
  await page.locator('#chain').selectOption('8453');
  await page.locator('#dest').fill('0x1111111111111111111111111111111111111111');
  await page.locator('#start').click();
  await page.locator('#setupError').waitFor({ state: 'visible' });
  assert.match(await page.locator('#setupError').innerText(), /does not support|不支持/);
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('active')).active), undefined);

  await page.locator('#chain').selectOption('1');
  await page.locator('#start').click();
  await page.locator('#session').waitFor({ state: 'visible', timeout: 60000 });
  const stored = await page.evaluate(async () => (await chrome.storage.local.get('active')).active);
  assert.equal(stored.mode, 'tornado');
  assert.match(stored.privateKey, /^0x[0-9a-f]{64}$/i);
  assert.match(stored.secondWallet.privateKey, /^0x[0-9a-f]{64}$/i);
  assert.notEqual(stored.address, stored.secondWallet.address);
  assert.equal(await page.locator('#address').innerText(), stored.address);
  assert.equal(await page.locator('#mixSecondAddress').innerText(), stored.secondWallet.address);
  assert.equal(await page.locator('#mixSteps li').count(), 5);

  const proofCheck = await page.evaluate(async (recipient) => {
    const note = await TornadoCrypto.createNote({ currency: 'eth', amount: '0.1', chainId: 1 });
    try {
      const result = await TornadoCrypto.prove({ note: note.note, leaves: [note.commitment],
        recipient, relayer: '0x2222222222222222222222222222222222222222', fee: '100000000000000' });
      return { proofLength: result.proof.length, recipient: result.args[2] };
    } finally { await TornadoCrypto.dispose(); }
  }, stored.secondWallet.address);
  assert.equal(proofCheck.proofLength, 514);
  assert.equal(proofCheck.recipient.toLowerCase(), stored.secondWallet.address.toLowerCase());

  const duplicate = await context.newPage();
  await duplicate.goto(appUrl);
  await duplicate.locator('#setupError').waitFor({ state: 'visible' });
  assert.match(await duplicate.locator('#setupError').innerText(), /Another window|另一个窗口/);
  assert.equal(await duplicate.locator('#start').isDisabled(), true);
  await duplicate.close();

  const downloaded = page.waitForEvent('download');
  await page.locator('#mixBackup').click();
  const backup = await downloaded;
  assert.match(backup.suggestedFilename(), /^relay-wallet-backup-/);
  await page.locator('#lang').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.match(await page.locator('#mixSteps').innerText(), /第二钱包/);

  await page.reload();
  await page.locator('#session').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#address').innerText(), stored.address);
  assert.equal(await page.locator('#mixSecondAddress').innerText(), stored.secondWallet.address);
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await mkdir(path.join(root, 'work'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'work/beta-extension.png'), fullPage: true });
  assert.deepEqual(errors, [], 'Browser raised script errors');
  console.log('PASS: actual MV3 extension, CSP/WASM workers, unsupported asset guard, two durable wallets, progress, backup, duplicate-page lock, language and restart');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
