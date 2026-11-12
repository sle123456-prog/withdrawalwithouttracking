'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../extension/vendor/ethers.umd.min.js');
const FeeEstimator = require('../extension/fee-estimator.js');

const ETH = { id: 1, symbol: 'ETH' };
const DEST = '0x1111111111111111111111111111111111111111';
const SOURCE = '0x2222222222222222222222222222222222222222';
const GAS_WALLET = '0x3333333333333333333333333333333333333333';
const TOKEN = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const POOL = '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc';
const AT = 1800000000000;
const goodPrice = { usd: 3000, status: 'fresh', source: 'test', updatedAt: AT, fetchedAt: AT };
const json = (data) => ({ ok: true, json: async () => data });

function harness(options = {}) {
  const h = { at: AT, requests: [] };
  h.provider = {
    getNetwork: async () => ({ chainId: BigInt(options.chain?.id || 1) }),
    getFeeData: async () => ({ gasPrice: 1000000000n }),
    getCode: async () => '0x',
    estimateGas: async () => 50000n,
    ...options.provider,
  };
  h.estimator = FeeEstimator.create({ ethers: E, now: () => h.at,
    fetch: async (url, init) => {
      h.requests.push({ url, init });
      if (options.fetch) return options.fetch(url, init, h);
      const id = new URL(url).searchParams.get('ids') || 'ethereum';
      return json({ [id]: { usd: 3000, last_updated_at: Math.floor(h.at / 1000) } });
    }, ...options.deps });
  h.input = { chain: options.chain || ETH, provider: h.provider, asset: 'native', dest: DEST,
    sourceAddress: SOURCE, gasWalletAddress: GAS_WALLET, secondAddress: GAS_WALLET, price: goodPrice };
  return h;
}

test('ordinary ETH gas is exact in wei, uses a fee reserve and converts to USD', async () => {
  const h = harness();
  const result = await h.estimator.estimate(h.input);
  assert.equal(result.gasPriceWei, '1200000000');
  assert.equal(result.networkWei, '25200000000000');
  assert.equal(result.totalWei, result.networkWei);
  assert.equal(result.nativeAmount, '0.0000252');
  assert.ok(Math.abs(result.totalUsd - 0.0756) < 1e-12);
  assert.equal(result.complete, true);
  assert.equal(result.serviceWei, '0');
  assert.deepEqual(result.warnings, []);
  assert.equal(JSON.parse(JSON.stringify(result)).totalWei, result.totalWei);
});

test('an explicitly budgeted gas price does not receive the reserve twice', async () => {
  const h = harness();
  const result = await h.estimator.estimate({ ...h.input, gasPriceWei: '1000000000' });
  assert.equal(result.totalWei, '21000000000000');
});

test('contract recipients use simulation and a gas-limit margin', async () => {
  const h = harness({ provider: { getCode: async () => '0x6000', estimateGas: async () => 40000n } });
  const result = await h.estimator.estimate(h.input);
  assert.equal(result.components[0].gasUnits, '52000');
  assert.equal(result.totalWei, '62400000000000');
});

test('Arbitrum simulates even EOA transfers to include Nitro data gas in the gas limit', async () => {
  const h = harness({ chain: { id: 42161, symbol: 'ETH' }, provider: { estimateGas: async () => 120000n } });
  const result = await h.estimator.estimate(h.input);
  assert.equal(result.components[0].gasUnits, '156000');
  assert.equal(result.totalWei, '187200000000000');
});

test('Arbitrum reference with no recipient still queries Nitro gas and explicitly reports a failed estimate', async () => {
  let estimates = 0;
  const h = harness({ chain: { id: 42161, symbol: 'ETH' }, provider: { estimateGas: async () => {
    estimates++;
    return 120000n;
  } } });
  const result = await h.estimator.estimate({ ...h.input, dest: undefined });
  assert.equal(estimates, 1);
  assert.equal(result.reference, true);
  assert.equal(result.components[0].gasUnits, '156000');
  const failing = harness({ chain: { id: 42161, symbol: 'ETH' }, provider: { estimateGas: async () => { throw new Error('insufficient funds'); } } });
  const partial = await failing.estimator.estimate({ ...failing.input, dest: undefined });
  assert.equal(partial.complete, false);
  assert.equal(partial.l1Complete, false);
  assert.ok(partial.warnings.includes('feeFallback'));
  assert.ok(partial.warnings.includes('feeL1Unavailable'));
});

test('token estimate includes three transaction fees but never counts gas-funding principal as gas', async () => {
  const h = harness({ provider: { estimateGas: async () => { throw new Error('insufficient funds'); } } });
  const result = await h.estimator.estimate({ ...h.input, asset: TOKEN, amountWei: '1000000' });
  assert.deepEqual(result.components.map((x) => x.kind), ['tokenTransfer', 'gasFunding', 'gasReturn']);
  assert.equal(result.totalWei, String(172000n * 1200000000n));
  assert.ok(result.warnings.includes('feeFallback'));
  const withoutFunding = await h.estimator.estimate({ ...h.input, asset: TOKEN, includeFunding: false });
  assert.equal(withoutFunding.components.length, 1);
  assert.equal(withoutFunding.totalWei, String(130000n * 1200000000n));
});

test('L2 oracle fees are included and an oracle failure is explicit rather than silently zero', async () => {
  const h = harness({ chain: { id: 10, symbol: 'ETH', l1Oracle: GAS_WALLET } });
  const complete = await h.estimator.estimate({ ...h.input, estimateL1Fee: async () => 123n });
  assert.equal(complete.totalWei, String(25200000000000n + 123n));
  assert.equal(complete.l1Complete, true);
  const partial = await h.estimator.estimate({ ...h.input, estimateL1Fee: async () => { throw new Error('oracle unavailable'); } });
  assert.equal(partial.totalWei, '25200000000000');
  assert.equal(partial.components[0].l1Wei, null);
  assert.equal(partial.complete, false);
  assert.ok(partial.warnings.includes('feeL1Unavailable'));
  const missing = await h.estimator.estimate(h.input);
  assert.equal(missing.l1Complete, false);
});

test('Tornado setup is a one-note reference and cannot invent an unknown relayer service fee', async () => {
  const h = harness();
  const result = await h.estimator.estimate({ ...h.input, mode: 'tornado' });
  assert.equal(result.reference, true);
  assert.equal(result.noteCount, 1);
  assert.deepEqual(result.components.map((x) => x.kind), ['deposit', 'withdrawal', 'finalTransfer']);
  assert.equal(result.networkWei, String((1400000n + 660000n + 21000n) * 1200000000n));
  assert.equal(result.serviceWei, null);
  assert.equal(result.serviceFeeKnown, false);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.includes('feeRelayerUnknown'));
  assert.ok(result.warnings.includes('feeReference'));
});

test('Tornado batch forecast counts every note and separates network gas from the relayer percentage', async () => {
  const h = harness();
  const plan = [{ address: POOL, amount: E.parseEther('1').toString() },
    { address: POOL, amount: E.parseEther('0.1').toString() }];
  const notes = [{ relayer: { serviceFee: 0.4 } },
    { relayer: { serviceFee: 9 }, withdrawalIntent: { relayer: { tornadoServiceFee: 0.5 } } }];
  const result = await h.estimator.estimate({ ...h.input, mode: 'tornado', plan, notes });
  assert.equal(result.reference, false);
  assert.equal(result.noteCount, 2);
  assert.equal(result.networkWei, String((2n * (1400000n + 660000n) + 21000n) * 1200000000n));
  assert.equal(result.serviceWei, E.parseEther('0.0045').toString());
  assert.equal(result.totalWei, String(BigInt(result.networkWei) + E.parseEther('0.0045')));
  assert.equal(result.complete, true);
});

test('partial relayer knowledge preserves only known service amounts and marks the total as incomplete', async () => {
  const h = harness();
  const plan = [{ amount: E.parseEther('0.1').toString() }, { amount: E.parseEther('0.1').toString() }];
  const result = await h.estimator.estimate({ ...h.input, mode: 'tornado', plan, notes: [{ serviceFeeWei: '123' }, {}] });
  assert.equal(result.serviceWei, null);
  assert.equal(result.knownServiceWei, '123');
  assert.equal(BigInt(result.totalWei) - BigInt(result.networkWei), 123n);
  assert.equal(result.complete, false);
});

test('Tornado L2 forecasts include every L1 fee and the chain-specific withdrawal gas budget', async () => {
  const h = harness({ chain: { id: 10, symbol: 'ETH', l1Oracle: GAS_WALLET } });
  const result = await h.estimator.estimate({ ...h.input, mode: 'tornado', estimateL1Fee: async () => 100n });
  assert.equal(result.components.find((x) => x.kind === 'withdrawal').gasUnits, '528000');
  assert.equal(result.networkWei, String((1400000n + 528000n + 21000n) * 1200000000n + 300n));
  assert.equal(result.l1Complete, true);
});

test('a 100-note L2 batch memoizes identical full L1 transactions only within that estimate', async () => {
  const h = harness({ chain: { id: 10, symbol: 'ETH', l1Oracle: GAS_WALLET } });
  const plan = Array.from({ length: 100 }, () => ({ amount: E.parseEther('0.1').toString() }));
  let calls = 0;
  const input = { ...h.input, mode: 'tornado', plan, estimateL1Fee: async () => { calls++; return 100n; } };
  const result = await h.estimator.estimate(input);
  assert.equal(calls, 3, 'one deposit, one withdrawal and one final transfer payload');
  assert.equal(result.components.length, 201);
  assert.equal(result.networkWei, String((100n * (1400000n + 528000n) + 21000n) * 1200000000n + 20100n));
  await h.estimator.estimate(input);
  assert.equal(calls, 6, 'a later estimate must fetch current L1 prices again');
});

test('currency mapping covers all native coins without assuming that xDAI always equals one USD', async () => {
  for (const [id, coin] of Object.entries({ 1: 'ethereum', 56: 'binancecoin', 137: 'polygon-ecosystem-token',
    43114: 'avalanche-2', 5000: 'mantle', 100: 'xdai' })) {
    const h = harness();
    assert.equal(h.estimator.priceId({ id: Number(id) }), coin);
    const price = await h.estimator.getUsdPrice({ id: Number(id) });
    assert.equal(price.usd, 3000);
    assert.match(h.requests[0].url, new RegExp('ids=' + coin));
  }
});

test('public USD requests contain only coin identifiers, share ETH cache across chains and deduplicate concurrent fetches', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.estimator.getUsdPrice(ETH), h.estimator.getUsdPrice({ id: 10 })]);
  assert.equal(first.usd, 3000);
  assert.equal(second.usd, 3000);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.body, undefined);
  assert.equal(request.url.includes(SOURCE), false);
  assert.deepEqual([...new URL(request.url).searchParams.keys()].sort(), ['ids', 'include_last_updated_at', 'vs_currencies']);
  await h.estimator.getUsdPrice({ id: 42161 });
  assert.equal(h.requests.length, 1);
});

test('public fallback validates timestamps and confidence and reports its source', async () => {
  const h = harness({ fetch: async (url) => {
    if (url.includes('coingecko.com')) return { ok: false };
    return json({ coins: { 'coingecko:ethereum': { price: 2999, timestamp: AT / 1000, confidence: 0.99 } } });
  } });
  const price = await h.estimator.getUsdPrice(ETH);
  assert.equal(price.usd, 2999);
  assert.equal(price.source, 'DefiLlama');
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].url, /^https:\/\/coins\.llama\.fi\/prices\/current\/coingecko:ethereum$/);
});

test('failed refresh uses explicitly stale recent data, but expires it rather than showing a fabricated USD value', async () => {
  let fail = false;
  const h = harness({ fetch: async () => {
    if (fail) throw new Error('offline');
    return json({ ethereum: { usd: 3000, last_updated_at: AT / 1000 } });
  } });
  await h.estimator.getUsdPrice(ETH);
  fail = true;
  h.at += 61000;
  const stale = await h.estimator.getUsdPrice(ETH);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.usd, 3000);
  h.at += 16 * 60000;
  const expired = await h.estimator.getUsdPrice(ETH);
  assert.equal(expired.status, 'unavailable');
  assert.equal(expired.usd, null);
  const estimate = await h.estimator.estimate({ ...h.input, price: expired });
  assert.equal(estimate.totalWei, '25200000000000');
  assert.equal(estimate.totalUsd, null);
  assert.ok(estimate.warnings.includes('feePriceUnavailable'));
});

test('stale, future, missing and nonfinite API values cannot become a fresh price', async () => {
  for (const item of [
    { usd: 3000, last_updated_at: AT / 1000 - 3600 },
    { usd: 3000, last_updated_at: AT / 1000 + 3600 },
    { usd: Infinity, last_updated_at: AT / 1000 },
    { usd: -1, last_updated_at: AT / 1000 },
    { usd: 3000 },
  ]) {
    const h = harness({ fetch: async (url) => url.includes('coingecko.com') ? json({ ethereum: item }) :
      json({ coins: { 'coingecko:ethereum': { price: 3000, timestamp: AT / 1000, confidence: 0.5 } } }) });
    const result = await h.estimator.getUsdPrice(ETH);
    assert.equal(result.usd, null);
    assert.equal(result.status, 'unavailable');
  }
});

test('price requests have a real deadline even when a fetch implementation ignores abort', async () => {
  const signals = [];
  const h = harness({ deps: { timeoutMs: 5 }, fetch: async (_, init) => {
    signals.push(init.signal);
    return new Promise(() => {});
  } });
  const result = await h.estimator.getUsdPrice(ETH);
  assert.equal(result.status, 'unavailable');
  assert.equal(signals.length, 2);
  assert.equal(signals.every((s) => s.aborted), true);
});

test('wrong RPC networks and unsupported Tornado choices cannot get a plausible fee forecast', async () => {
  const wrong = harness({ provider: { getNetwork: async () => ({ chainId: 56n }) } });
  await assert.rejects(wrong.estimator.estimate(wrong.input), /feeWrongNetwork/);
  const h = harness();
  await assert.rejects(h.estimator.estimate({ ...h.input, mode: 'tornado', asset: TOKEN }), /feeUnsupported/);
  const base = harness({ chain: { id: 8453, symbol: 'ETH' } });
  await assert.rejects(base.estimator.estimate({ ...base.input, mode: 'tornado' }), /feeUnsupported/);
  await assert.rejects(h.estimator.estimate({ ...h.input, mode: 'tornado', plan: Array.from({ length: 101 }, () => ({ amount: '1' })) }), /feeInvalidContext/);
});
