import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import verifier from '../test/helpers/tornado-verifier.cjs';

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
let failPrices = false;
let priceRequests = 0;
try {
  // All external traffic is mocked: this test never touches a funded chain.
  await context.route('https://**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && ['api.coingecko.com', 'coins.llama.fi'].includes(url.hostname)) {
      priceRequests++;
      if (failPrices) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Price feed unavailable"}' });
      const timestamp = Math.floor(Date.now() / 1000);
      const data = url.hostname === 'api.coingecko.com'
        ? Object.fromEntries((url.searchParams.get('ids') || '').split(',').filter(Boolean)
          .map((id) => [id, { usd: 3000, last_updated_at: timestamp }]))
        : { coins: Object.fromEntries(decodeURIComponent(url.pathname.replace('/prices/current/', '')).split(',').filter(Boolean)
          .map((id) => [id, { price: 3000, timestamp, confidence: 0.99 }])) };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    }
    let payload;
    try { payload = request.postDataJSON(); } catch {}
    if (!payload) return route.abort();
    const chainId = (() => {
      const host = url.hostname;
      if (/arbitrum|arb1/.test(host)) return 42161;
      if (/optimism/.test(host)) return 10;
      if (/bsc|binance|defibit|ninicoin/.test(host)) return 56;
      if (/polygon/.test(host)) return 137;
      if (/avalanche|avax/.test(host)) return 43114;
      if (/linea/.test(host)) return 59144;
      if (/zksync/.test(host)) return 324;
      if (/scroll/.test(host)) return 534352;
      if (/mantle/.test(host)) return 5000;
      if (/gnosis/.test(host)) return 100;
      if (/(^|\.)base\.|base-rpc/.test(host)) return 8453;
      return 1;
    })();
    const respond = (item) => {
      if (item.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: item.id, result: {
        number: /^0x[0-9a-f]+$/i.test(item.params?.[0]) ? item.params[0] : '0x1000000',
        hash: '0x' + 'aa'.repeat(32), parentHash: '0x' + 'bb'.repeat(32),
        timestamp: '0x65000000', nonce: '0x0000000000000000', difficulty: '0x0',
        gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x0000000000000000000000000000000000000000',
        extraData: '0x', transactions: [], baseFeePerGas: '0x3b9aca00',
      } };
      const values = { eth_chainId: '0x' + chainId.toString(16), eth_getBalance: '0x0', eth_blockNumber: '0x1000000',
        eth_gasPrice: '0x3b9aca00', eth_maxPriorityFeePerGas: '0x3b9aca00', eth_getLogs: [],
        eth_getCode: '0x', eth_estimateGas: '0x5208' };
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
  assert.equal(await page.locator('#mixMode').isVisible(), true);
  await page.waitForFunction(() =>
    /ETH/.test(document.getElementById('feeNormalNative').textContent) &&
    /\$/.test(document.getElementById('feeNormalUsd').textContent) &&
    /ETH/.test(document.getElementById('feeTornadoNative').textContent) &&
    /\$/.test(document.getElementById('feeTornadoUsd').textContent));
  assert.match(await page.locator('#mixModeHint').innerText(), /0\.1 ETH/);
  assert.match(await page.locator('#mixModeHint').innerText(), /Gas costs are very high|Gas 成本极高/);
  assert.match(await page.locator('#mixModeHint').innerText(), /not for beginners|小白禁用/);
  assert.match(await page.locator('#feeRelayerService').innerText(), /Awaiting|待/);
  assert.match(await page.locator('#feeTotalNative').innerText(), /Awaiting|待|—/);
  assert.equal(await page.locator('#feeAmount').isVisible(), true);
  const feeValue = async () => Number((await page.locator('#feeTornadoNative').innerText()).replace(/[^\d.]/g, ''));
  const oneDepositFee = await feeValue();
  assert(oneDepositFee > 0, 'The Tornado reference estimate must show a positive network fee');
  await page.locator('#feeAmount').fill('0.2');
  await page.waitForFunction((previous) => Number(document.getElementById('feeTornadoNative').textContent.replace(/[^\d.]/g, '')) > previous, oneDepositFee);
  assert(await feeValue() > oneDepositFee, 'Two deposits must cost more than one deposit');
  await page.locator('#feeAmount').fill('0.15');
  await page.waitForFunction(() => /whole multiple|整倍数/.test(document.getElementById('feeEstimateStatus').textContent));
  assert(!/\d/.test(await page.locator('#feeTornadoNative').innerText()), 'Invalid principal must clear the previous Tornado quote');
  await page.locator('#feeAmount').fill('');
  await page.waitForFunction(() => /ETH/.test(document.getElementById('feeTornadoNative').textContent));

  const previousPriceRequests = priceRequests;
  failPrices = true;
  await Promise.all([
    page.waitForResponse((response) => response.url().startsWith('https://api.coingecko.com/') && response.status() === 503),
    page.waitForResponse((response) => response.url().startsWith('https://coins.llama.fi/') && response.status() === 503),
    page.locator('#refreshFees').click(),
  ]);
  await page.waitForFunction(() => {
    const note = document.getElementById('feeEstimateNote').textContent;
    const usd = document.getElementById('feeNormalUsd').textContent;
    return /out of date|cached|过期|缓存/.test(note) || (!/\$/.test(usd) && /unavailable|无法/.test(usd));
  });
  assert(priceRequests >= previousPriceRequests + 2, 'A forced refresh must try both price sources');
  assert.match(await page.locator('#feeNormalNative').innerText(), /ETH/);
  const unavailableUsd = await page.locator('#feeNormalUsd').innerText();
  const cachedDollars = /\$\s*([\d,.]+)/.exec(unavailableUsd);
  if (cachedDollars) assert(Number(cachedDollars[1].replace(/,/g, '')) > 0, 'A price failure must not become a fake zero-dollar fee');
  failPrices = false;
  await Promise.all([
    page.waitForResponse((response) => response.url().startsWith('https://api.coingecko.com/') && response.status() === 200),
    page.locator('#refreshFees').click(),
  ]);
  await page.waitForFunction(() => /\$/.test(document.getElementById('feeNormalUsd').textContent));
  await page.locator('#mixMode').check();
  await page.locator('#asset').selectOption('0xdac17f958d2ee523a2206206994597c13d831ec7');
  assert.equal(await page.locator('#mixMode').isVisible(), false);
  assert.equal(await page.locator('#feeTornadoRow').isVisible(), false);
  assert.equal(await page.locator('#mixMode').isChecked(), false);
  assert.equal(await page.locator('#mixMode').isDisabled(), true);
  await page.locator('#asset').selectOption('native');
  assert.equal(await page.locator('#mixMode').isVisible(), true);
  assert.equal(await page.locator('#mixMode').isChecked(), false);
  for (const chainId of ['1', '56', '137', '42161', '10', '8453', '43114', '59144', '324', '534352', '5000', '100']) {
    await page.locator('#chain').selectOption(chainId);
    const supportedEth = ['1', '10', '42161'].includes(chainId);
    assert.equal(await page.locator('#mixMode').isVisible(), supportedEth, 'Mode visibility on chain ' + chainId);
    assert.equal(await page.locator('#mixRelayerOptions').evaluate((el) => !el.hidden), supportedEth);
    assert.equal(await page.locator('#feeTornadoRow').isVisible(), supportedEth, 'Tornado estimate visibility on chain ' + chainId);
  }
  await page.locator('#chain').selectOption('8453');
  // The action also validates eligibility if a stale or modified checkbox is set.
  await page.evaluate(() => { document.getElementById('mixMode').checked = true; });
  await page.locator('#dest').fill('0x1111111111111111111111111111111111111111');
  await page.locator('#start').click();
  await page.locator('#setupError').waitFor({ state: 'visible' });
  assert.match(await page.locator('#setupError').innerText(), /does not support|不支持/);
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('active')).active), undefined);

  await page.locator('#chain').selectOption('1');
  assert.equal(await page.locator('#mixMode').isChecked(), false);
  await page.locator('#mixMode').check();
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
  await page.waitForFunction(() => /ETH/.test(document.getElementById('feeNormalNative').textContent) &&
    /\$/.test(document.getElementById('feeNormalUsd').textContent) &&
    /ETH/.test(document.getElementById('feeTornadoNative').textContent));
  assert.equal(await page.locator('#feeAmount').isVisible(), false, 'An active session uses its actual batch, not the optional setup principal');

  const proofCheck = await page.evaluate(async (recipient) => {
    const note = await TornadoCrypto.createNote({ currency: 'eth', amount: '0.1', chainId: 1 });
    let timeout;
    try {
      const result = await Promise.race([
        TornadoCrypto.prove({ note: note.note, leaves: [note.commitment],
          recipient, relayer: '0x2222222222222222222222222222222222222222', fee: '100000000000000' }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Browser proof timed out')), 120000); }),
      ]);
      return { proofLength: result.proof.length, recipient: result.args[2], proof: result.proof, args: result.args };
    } finally { clearTimeout(timeout); await TornadoCrypto.dispose(); }
  }, stored.secondWallet.address);
  assert.equal(proofCheck.proofLength, 514);
  assert.equal(proofCheck.recipient.toLowerCase(), stored.secondWallet.address.toLowerCase());
  assert.equal(verifier.verify(proofCheck.proof, proofCheck.args), true, 'The actual browser proof failed independent verification');
  const waitingState = await page.evaluate(async () => (await chrome.storage.local.get('active')).active.mix);
  assert.equal(waitingState.phase, 'waiting');
  assert.equal(waitingState.error, undefined, 'Mocked RPC caused a hidden background failure');
  assert.equal(await page.locator('#status').evaluate((el) => el.classList.contains('err')), false);

  const duplicate = await context.newPage();
  await duplicate.goto(appUrl);
  await duplicate.locator('#setupError').waitFor({ state: 'visible' });
  assert.match(await duplicate.locator('#setupError').innerText(), /Another window|另一个窗口/);
  assert.equal(await duplicate.locator('#start').isDisabled(), true);
  await duplicate.close();

  await page.locator('summary[data-i18n="mixBackupTitle"]').click();
  const [backup] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#mixBackup').click(),
  ]);
  assert.match(backup.suggestedFilename(), /^relay-wallet-backup-/);
  const backedUp = JSON.parse(await readFile(await backup.path(), 'utf8'));
  assert.equal(backedUp.session.id, stored.id);
  assert.equal(backedUp.session.privateKey, stored.privateKey);
  assert.equal(backedUp.session.secondWallet.privateKey, stored.secondWallet.privateKey);
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
  console.log('PASS: actual MV3 extension, fee/price estimates and failure handling, ETH-only mode visibility, CSP/WASM workers, two durable wallets, progress, backup, duplicate-page lock, language and restart');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
