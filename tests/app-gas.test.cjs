'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const E = require('../extension/vendor/ethers.umd.min.js');

// Exercise the real application entry points and forwarding functions. Only
// the browser, wallet transport and RPC are replaced; no funded chain is used.
const source = fs.readFileSync(require.resolve('../extension/app.js'), 'utf8').split('\nboot().catch(')[0];
const key = (n) => '0x' + n.toString(16).padStart(64, '0');
const address = (n) => new E.Wallet(key(n)).address;
const tokenAddress = address(20);
const transfer = new E.Interface(['function transfer(address,uint256)']);

function harness({ sourceNative = 0n, tokens = 1000000n } = {}) {
  const first = new E.Wallet(key(1));
  const donor = new E.Wallet(key(2));
  const destination = new E.Wallet(key(3));
  const h = { data: {}, writes: [], transactions: [], rpcReads: 0, tokens, shown: null,
    native: new Map([[first.address, sourceNative], [donor.address, E.parseEther('1')]]),
    session: { id: 'ordinary-token', chainId: 1, rpc: '', asset: tokenAddress, assetSymbol: 'USDC',
      decimals: 6, address: first.address, privateKey: first.privateKey, dest: destination.address,
      phase: 'waiting', txs: [] },
    donor: { address: donor.address, privateKey: donor.privateKey }, destination: destination.address };
  const count = (value) => { h.rpcReads++; return value; };
  const provider = {
    getNetwork: async () => count({ chainId: 1n }),
    getBalance: async (who) => count(h.native.get(E.getAddress(who)) || 0n),
    getFeeData: async () => count({ gasPrice: 1000000000n }),
    estimateGas: async (tx) => count(tx.data ? 65000n : 21000n),
    destroy() {},
  };
  class Wallet {
    constructor(privateKey) {
      const wallet = new E.Wallet(privateKey);
      this.privateKey = wallet.privateKey;
      this.address = wallet.address;
    }
    static createRandom() { return new Wallet(first.privateKey); }
    async sendTransaction(request) {
      const tx = { ...request, from: this.address, hash: key(100 + h.transactions.length) };
      h.transactions.push(tx);
      return { hash: tx.hash, wait: async () => {
        const fee = request.gasLimit * request.gasPrice;
        if (request.data) {
          const decoded = transfer.parseTransaction({ data: request.data });
          assert.equal(E.getAddress(request.to), tokenAddress);
          assert.equal(decoded.args[0], destination.address);
          assert.equal(decoded.args[1], h.tokens);
          h.tokens = 0n;
          h.native.set(this.address, (h.native.get(this.address) || 0n) - fee);
        } else {
          const to = E.getAddress(request.to);
          h.native.set(this.address, (h.native.get(this.address) || 0n) - request.value - fee);
          h.native.set(to, (h.native.get(to) || 0n) + request.value);
        }
        return { status: 1 };
      } };
    }
  }
  class Contract {
    constructor(who) { assert.equal(E.getAddress(who), tokenAddress); }
    async balanceOf() { return count(h.tokens); }
    async decimals() { return count(6n); }
    async symbol() { return count('USDC'); }
  }
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: '', textContent: '', className: '' });
    return elements.get(id);
  };
  Object.assign(element('chain'), { value: '1' });
  Object.assign(element('asset'), { value: tokenAddress });
  Object.assign(element('dest'), { value: destination.address });
  Object.assign(element('mixMode'), { checked: false });
  const context = vm.createContext({
    ethers: { ...E, Wallet, Contract, JsonRpcProvider: class { constructor() { return provider; } } },
    CHAINS: [{ id: 1, name: 'Ethereum', symbol: 'ETH', rpcs: ['https://mock.invalid'], explorer: 'https://mock.invalid' }],
    t: (name) => name, vault: { enabled: false, unlocked: false }, console, setTimeout, clearTimeout,
    navigator: {}, document: { getElementById: element },
    chrome: { storage: { local: {
      get: async (name) => ({ [name]: h.data[name] }),
      set: async (values) => { const copy = JSON.parse(JSON.stringify(values)); h.writes.push(copy); Object.assign(h.data, copy); },
      remove: async (name) => { delete h.data[name]; },
    } } },
    onSessionShown: (s) => {
      assert.equal(h.data.active.privateKey, s.privateKey, 'The key must be durable before showing an address');
      h.shown = s.address;
    },
  });
  vm.runInContext(source + `
    renderTxs = () => {};
    refreshGasBalance = () => {};
    showSession = () => onSessionShown(active);
    this.appGasApi = {
      onStart, tickUnlocked,
      setState(s, g = null) { active = s; gasWallet = g; history = []; appReady = true; busy = false; securityBusy = false; provider = null; providerKey = ''; },
      setGate(ready, security, processing) { appReady = ready; securityBusy = security; busy = processing; },
      getState() { return { active, gasWallet, history }; }
    };`, context);
  h.api = context.appGasApi;
  h.elements = elements;
  return h;
}

test('ordinary ERC20 address creation does not require a Gas wallet and saves its key first', async () => {
  const h = harness();
  h.api.setState(null);
  await h.api.onStart();
  const current = h.api.getState().active;
  assert.equal(current.asset, tokenAddress);
  assert.equal(current.decimals, 6);
  assert.equal(current.assetSymbol, 'USDC');
  assert.equal(h.api.getState().gasWallet, null);
  assert.equal(h.shown, current.address);
  assert.equal(h.data.active.privateKey, current.privateKey);
  assert.equal(h.transactions.length, 0);
});

test('an unfunded ordinary token session without a Gas wallet waits for manual native gas', async () => {
  const h = harness();
  h.api.setState(h.session);
  await h.api.tickUnlocked();
  assert.equal(h.transactions.length, 0);
  assert.equal(h.session.phase, 'need_gas');
  assert(BigInt(h.session.needGas) > 0n);
  assert.equal(h.data.active.phase, 'need_gas');
  assert.equal(h.elements.get('status').textContent, 'stNeedGas');
});

test('self-funded ordinary tokens go to B once and leave remaining native coins in the receiving wallet', async () => {
  const h = harness({ sourceNative: E.parseEther('0.01') });
  h.api.setState(h.session);
  await h.api.tickUnlocked();
  assert.equal(h.session.phase, 'done');
  assert.equal(h.transactions.length, 1);
  assert.equal(h.transactions[0].to, tokenAddress);
  assert.equal(h.session.txs[0].key, 'txForward');
  assert(h.native.get(h.session.address) > 0n);
  assert.equal(h.transactions.some((tx) => !tx.data && E.getAddress(tx.to) === h.destination), false);
  await h.api.tickUnlocked();
  assert.equal(h.transactions.length, 1, 'A completed token transfer must not sweep the native remainder later');
});

test('a bound Gas wallet funds token forwarding and receives leftover gas instead of B', async () => {
  const h = harness();
  h.api.setState(h.session, h.donor);
  await h.api.tickUnlocked();
  assert.equal(h.session.phase, 'done');
  assert.equal(h.session.gasFunded, true);
  assert.equal(h.transactions.length, 3);
  assert.equal(E.getAddress(h.transactions[0].to), h.session.address);
  assert.equal(h.transactions[0].from, h.donor.address);
  assert.equal(h.transactions[1].to, tokenAddress);
  assert.equal(E.getAddress(h.transactions[2].to), h.donor.address);
  assert.equal(h.transactions[2].from, h.session.address);
  assert(h.transactions[2].value > 0n);
  assert.deepEqual(Array.from(h.session.txs, (tx) => tx.key), ['txFund', 'txForward', 'txLeftGas']);
  assert.equal(h.transactions.some((tx) => !tx.data && E.getAddress(tx.to) === h.destination), false);
});

test('a locked page or security transition cannot query, persist or transfer funds', async () => {
  for (const flags of [[false, false, false], [true, true, false], [true, false, true]]) {
    const h = harness({ sourceNative: E.parseEther('0.01') });
    h.api.setState(h.session, h.donor);
    h.api.setGate(...flags);
    await h.api.tickUnlocked();
    assert.equal(h.rpcReads, 0);
    assert.equal(h.transactions.length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.session.phase, 'waiting');
  }
});
