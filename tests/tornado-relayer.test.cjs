'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../extension/vendor/ethers.umd.min.js');
const Pools = require('../extension/tornado-pools.js');
const { create } = require('../extension/tornado-relayer.js');

const REWARD = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const nativePool = Pools.getPools(1).find((pool) => pool.amount === '0.1');
const usdcPool = Pools.getPools(1, Pools.networks[1].tokens.usdc.address).find((pool) => pool.amount === '100');
const blockHash = (number) => E.toBeHex(number, 32);
const registryIface = new E.Interface([
  'event RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount)',
  'function minStakeAmount() view returns (uint256)',
]);
const aggregatorIface = new E.Interface([
  'function relayersData(bytes32[],string[]) view returns ((address owner,uint256 balance,bool isRegistered,string[20] records)[])',
]);

function provider(chainId = 1, gasPrice = 1000000000n) {
  return { getNetwork: async () => ({ chainId: BigInt(chainId) }), getFeeData: async () => ({ gasPrice }) };
}

function status(pool = nativePool, changes = {}) {
  const native = pool.currency === Pools.networks[pool.chainId].currency;
  return {
    netId: pool.chainId, rewardAccount: REWARD, health: { status: 'true' }, tornadoServiceFee: 0.5,
    instances: { [pool.currency]: { instanceAddress: { [pool.amount]: pool.address }, decimals: pool.decimals,
      ...(native ? {} : { tokenAddress: Pools.networks[pool.chainId].tokens[pool.currency].address }) } },
    ethPrices: { usdc: '500000000000000' }, currentQueue: 0, ...changes,
  };
}

function response(data, code = 200) {
  return { ok: code >= 200 && code < 300, status: code, text: async () => JSON.stringify(data) };
}

function memoryStore() {
  const map = new Map();
  const writes = [];
  return {
    get: async (key) => structuredClone(map.get(key)),
    set: async (key, value) => { writes.push(structuredClone(value)); map.set(key, structuredClone(value)); },
    writes, map,
  };
}

async function selected(pool = nativePool, changes = {}, deps = {}) {
  const api = create({ ethers: E, pools: Pools, fetch: async () => response(status(pool, changes)), ...deps });
  const relayer = await api.select({ pool, provider: provider(pool.chainId), customUrl: 'https://relay.example/api' });
  return { api, relayer };
}

function registeredLog(name = 'valid.eth', account = REWARD, number = Pools.REGISTRY.deployedBlock + 5) {
  const event = registryIface.encodeEventLog('RelayerRegistered', [E.namehash(name), name, account, Pools.REGISTRY.minimumStake]);
  return { ...event, address: Pools.REGISTRY.address, blockNumber: number, index: 0, blockHash: blockHash(number) };
}

function registryProvider({ rangeLimit = Infinity, owner = REWARD, balance = Pools.REGISTRY.minimumStake,
  registered = true, host = 'relay.example', log = registeredLog(), currentMinimum = Pools.REGISTRY.minimumStake } = {}) {
  const from = Pools.REGISTRY.deployedBlock;
  const records = Array(20).fill('');
  records[0] = host;
  records[1] = 'bsc-relay.example';
  const result = {
    ...provider(), latest: from + 112, calls: [], reads: [], fork: false,
    getBlockNumber: async () => result.latest,
    getBlock: async (number) => ({ hash: blockHash(number + (result.fork ? 1 : 0)) }),
    getLogs: async (filter) => {
      result.calls.push(filter);
      if (filter.toBlock - filter.fromBlock + 1 > rangeLimit) throw new Error('RPC range limit');
      return log && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock ? [log] : [];
    },
    call: async (tx) => {
      result.reads.push(tx);
      if (tx.to.toLowerCase() === Pools.REGISTRY.address.toLowerCase()) {
        return registryIface.encodeFunctionResult('minStakeAmount', [currentMinimum]);
      }
      assert.equal(tx.to.toLowerCase(), Pools.REGISTRY.aggregator.toLowerCase());
      const [names, domains] = aggregatorIface.decodeFunctionData('relayersData', tx.data);
      assert.deepEqual([...names], [E.namehash('valid.eth')]);
      assert.deepEqual([...domains], Pools.REGISTRY.subdomains);
      return aggregatorIface.encodeFunctionResult('relayersData', [[[owner, balance, registered, records]]]);
    },
  };
  return result;
}

test('custom relayers normalize the base path and return a pool-bound public description', async () => {
  const calls = [];
  const { relayer } = await selected(nativePool, {}, { fetch: async (url, options) => {
    calls.push({ url, options }); return response(status());
  } });
  assert.equal(calls[0].url, 'https://relay.example/api/status');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(relayer.url, 'https://relay.example/api/');
  assert.equal(relayer.poolAddress, E.getAddress(nativePool.address));
  assert.equal(relayer.amountWei, '100000000000000000');
  assert.equal(relayer.registered, false);
});

test('unsafe URLs, credentials, and query-bearing URLs are rejected before HTTP', async () => {
  let calls = 0;
  const api = create({ ethers: E, pools: Pools, fetch: async () => { calls++; return response(status()); } });
  for (const customUrl of ['http://remote.example', 'file:///tmp/socket', 'javascript:alert(1)',
    'https://user:password@relay.example', 'https://relay.example/?secret=value', 'https://relay.example/#note']) {
    await assert.rejects(api.select({ pool: nativePool, provider: provider(), customUrl }));
  }
  assert.equal(calls, 0);
  await api.select({ pool: nativePool, provider: provider(), customUrl: 'http://localhost:8546' });
  await api.select({ pool: nativePool, provider: provider(), customUrl: 'http://127.0.0.1:8546' });
  assert.equal(calls, 2);
});

test('unhealthy, wrong-network, overcharging, and wrong-pool relayers cannot be selected', async () => {
  const badStatuses = [
    { netId: 56 }, { health: { status: false } }, { health: { status: 'false' } },
    { tornadoServiceFee: 20.0001 }, { tornadoServiceFee: -1 }, { tornadoServiceFee: '0.5' },
    { currentQueue: 6 }, { rewardAccount: E.ZeroAddress },
    { instances: { eth: { decimals: 18, instanceAddress: { '0.1': OTHER } } } },
    { instances: { eth: { decimals: 6, instanceAddress: { '0.1': nativePool.address } } } },
  ];
  for (const changes of badStatuses) await assert.rejects(selected(nativePool, changes));
  await assert.rejects(selected(usdcPool, { ethPrices: { usdc: '0' } }), /exchange rate/);
  await assert.rejects(selected(usdcPool, { instances: { usdc: {
    decimals: 6, instanceAddress: { '100': usdcPool.address }, tokenAddress: OTHER,
  } } }), /token contract/);
});

test('caller cannot replace the allowlisted pool, denomination, or RPC network', async () => {
  const api = create({ ethers: E, pools: Pools, fetch: async () => response(status()) });
  await assert.rejects(api.select({ pool: { ...nativePool, address: OTHER }, provider: provider(), customUrl: 'https://relay.example' }), /Unsupported/);
  await assert.rejects(api.select({ pool: { ...nativePool, value: '1' }, provider: provider(), customUrl: 'https://relay.example' }), /denomination/);
  await assert.rejects(api.select({ pool: nativePool, provider: provider(56), customUrl: 'https://relay.example' }), /chain/);
});

test('registry discovery adapts RPC ranges, validates ENS registration, and persists a confirmed checkpoint', async () => {
  const rpc = registryProvider({ rangeLimit: 64 });
  const storage = memoryStore();
  const api = create({ ethers: E, pools: Pools, fetch: async () => response(status()) });
  const relayer = await api.select({ pool: nativePool, provider: rpc, storage });
  assert.equal(relayer.registered, true);
  assert.equal(relayer.ensName, 'valid.eth');
  assert.equal(relayer.registeredAddress, REWARD);
  const cache = storage.writes.at(-1);
  assert.equal(cache.lastBlock, rpc.latest - 12);
  assert.equal(cache.lastHash, blockHash(rpc.latest - 12));
  assert.equal(cache.events.length, 1);
  assert.ok(rpc.calls.length > 1);
  const oldCallCount = rpc.calls.length;
  rpc.latest += 5;
  await api.select({ pool: nativePool, provider: rpc, storage });
  assert.equal(rpc.calls[oldCallCount].fromBlock, cache.lastBlock + 1);
});

test('a changed checkpoint block hash invalidates cached registrations and scans again', async () => {
  const rpc = registryProvider();
  const storage = memoryStore();
  const api = create({ ethers: E, pools: Pools, fetch: async () => response(status()) });
  await api.select({ pool: nativePool, provider: rpc, storage });
  const oldCallCount = rpc.calls.length;
  rpc.fork = true;
  await api.select({ pool: nativePool, provider: rpc, storage });
  assert.equal(rpc.calls[oldCallCount].fromBlock, Pools.REGISTRY.deployedBlock);
  assert.ok(storage.writes.includes(null));
});

test('registry discovery rejects owner mismatch, deregistration, insufficient stake, and unverified mainnet rewards', async () => {
  for (const invalid of [{ owner: OTHER }, { registered: false }, { balance: '1' },
    { currentMinimum: '50000000000000000000' }, { host: 'https://relay.example' }]) {
    const rpc = registryProvider(invalid);
    const api = create({ ethers: E, pools: Pools, fetch: async () => response(status()) });
    await assert.rejects(api.select({ pool: nativePool, provider: rpc }), /No registered/);
  }
  const api = create({ ethers: E, pools: Pools, fetch: async () => response(status(nativePool, { rewardAccount: OTHER })) });
  await assert.rejects(api.select({ pool: nativePool, provider: registryProvider() }), /No healthy/);
});

test('cross-chain discovery uses Ethereum registration and the selected chain subdomain', async () => {
  const pool = Pools.getPools(56).find((item) => item.amount === '0.1');
  const urls = [];
  const api = create({ ethers: E, pools: Pools, fetch: async (url) => { urls.push(url); return response(status(pool)); } });
  const relayer = await api.select({ pool, provider: provider(56), mainnetProvider: registryProvider() });
  assert.equal(relayer.url, 'https://bsc-relay.example/');
  assert.deepEqual(urls, ['https://bsc-relay.example/status']);
  await assert.rejects(api.select({ pool, provider: provider(56), mainnetProvider: provider(56) }), /chain/);
});

test('native quote uses integer arithmetic for service fees and a 20% network gas margin', async () => {
  const { api, relayer } = await selected();
  const quote = await api.quote({ pool: nativePool, provider: provider(), relayer, refund: '0' });
  assert.equal(quote.networkFee, '660000000000000');
  assert.equal(quote.fee, '1160000000000000');
  assert.equal(quote.refund, '0');
  await assert.rejects(api.quote({ pool: nativePool, provider: provider(), relayer, refund: '1' }), /do not support/);
  await assert.rejects(api.quote({ pool: nativePool, provider: provider(1, 100000000000n), relayer }), /20%/);
});

test('ERC20 quote includes native refund conversion and rounds upward in token units', async () => {
  const { api, relayer } = await selected(usdcPool);
  const quote = await api.quote({ pool: usdcPool, provider: provider(), relayer, refund: '100000000000001' });
  // 660000000000000 wei network + 100000000000001 wei refund, at 500000000000000 wei/USDC.
  assert.equal(quote.fee, '2020001');
  assert.equal(quote.refund, '100000000000001');
  await assert.rejects(api.quote({ pool: usdcPool, provider: provider(), relayer: { ...relayer, ethPrices: { usdc: '1' } } }), /20%/);
});

test('quote accounts for advertised relayer gas prices and refuses mismatched pool bindings', async () => {
  const { api, relayer } = await selected(nativePool, { gasPrices: { fast: 2 } });
  const quote = await api.quote({ pool: nativePool, provider: provider(), relayer });
  assert.equal(quote.gasPrice, '2000000000');
  await assert.rejects(api.quote({ pool: usdcPool, provider: provider(), relayer }), /different pool/);
});

test('submit sends only the public proof fields and binds both the relayer and contract', async () => {
  const calls = [];
  const { api, relayer } = await selected(nativePool, {}, { fetch: async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/status') ? status() : { id: 'job-123' });
  } });
  const args = [blockHash(1), blockHash(2), RECIPIENT, REWARD, '1000000000000000', '0'];
  const proof = '0x' + 'aa'.repeat(256);
  const result = await api.submit({ relayer, proof, args, contract: nativePool.address,
    note: 'NEVER_SEND_NOTE', secret: 'NEVER_SEND_SECRET', privateKey: 'NEVER_SEND_PRIVATE_KEY' });
  assert.deepEqual(result, { id: 'job-123' });
  const call = calls[1];
  assert.equal(call.url, 'https://relay.example/api/v1/tornadoWithdraw');
  assert.deepEqual(Object.keys(JSON.parse(call.options.body)).sort(), ['args', 'contract', 'proof']);
  assert.ok(!call.options.body.includes('NEVER_SEND'));
  await assert.rejects(api.submit({ relayer, proof, args: [...args.slice(0, 3), OTHER, ...args.slice(4)], contract: nativePool.address }), /different relayer/);
  await assert.rejects(api.submit({ relayer, proof, args, contract: OTHER }), /differs/);
  await assert.rejects(api.submit({ relayer, proof: 'tornado-eth-0.1-1-0xsecret', args, contract: nativePool.address }), /public withdrawal proof/);
  await assert.rejects(api.submit({ relayer, proof, args: [...args, 'NEVER_SEND_NOTE'], contract: nativePool.address }), /public withdrawal proof/);
  assert.equal(calls.length, 2);
});

test('job polling validates IDs and requires a transaction hash for confirmed jobs', async () => {
  let calls = 0;
  let body = { status: 'CONFIRMED', txHash: blockHash(100), confirmations: 12 };
  const api = create({ ethers: E, pools: Pools, fetch: async () => { calls++; return response(body); } });
  const job = await api.job({ url: 'https://relay.example', id: 'job-123' });
  assert.equal(job.txHash, blockHash(100));
  assert.equal(job.confirmations, 12);
  await assert.rejects(api.job({ url: 'https://relay.example', id: '../status?note=secret' }), /job ID/);
  assert.equal(calls, 1);
  body = { status: 'CONFIRMED' };
  await assert.rejects(api.job({ url: 'https://relay.example', id: 'job-123' }), /missing a transaction hash/);
});

test('relayer requests have an abort deadline and reject HTTP failures', async () => {
  const api = create({ ethers: E, pools: Pools, timeoutMs: 5, fetch: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  }) });
  await assert.rejects(api.select({ pool: nativePool, provider: provider(), customUrl: 'https://relay.example' }), /timed out/);
  const failed = create({ ethers: E, pools: Pools, fetch: async () => response({}, 503) });
  await assert.rejects(failed.select({ pool: nativePool, provider: provider(), customUrl: 'https://relay.example' }), /503/);
});
