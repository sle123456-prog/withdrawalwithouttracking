'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ethers = require('../extension/vendor/ethers.umd.min.js');
const vaultSource = fs.readFileSync(require.resolve('../extension/vault.js'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../extension/app.js'), 'utf8').split('\nboot().catch(')[0];
const secret = 'correct horse battery staple';
const session = { id: 'encrypted-tornado', mode: 'tornado', privateKey: 'first-private-key',
  secondWallet: { privateKey: 'second-private-key' }, mix: { notes: [{ note: 'secret-note',
    depositIntent: { raw: 'signed-transaction', hash: 'tx-hash' } }] },
  mixHistory: [{ notes: [{ note: 'previous-secret-note' }] }] };

function harness() {
  const data = {};
  const writes = [];
  const elements = new Map();
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array,
    btoa, atob, ethers, console, setTimeout, clearTimeout,
    t: (key) => key, chrome: { storage: { local: {
      get: async (key) => ({ [key]: data[key] }),
      set: async (values) => { writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); },
      remove: async (key) => { delete data[key]; },
    } } }, document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '' });
      return elements.get(id);
    } }, navigator: {},
  });
  vm.runInContext(vaultSource + '\n' + appSource + `\nthis.api = {
    vault, vaultCreate, vaultUnlock, vaultVerify, vaultSeal, vaultOpen, vaultForget, persist, secureWith, unlock,
    setState(a, h = [], g = null) { active = a; history = h; gasWallet = g; },
    setMeta(m) { vault.meta = m; },
    setBusy(b) { busy = b; },
    getSecurityBusy() { return securityBusy; }
  };`, context);
  return { api: context.api, data, writes, elements, context };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('password vault preserves both wallets, notes, journals and previous batches after restart', async () => {
  const h = harness();
  const meta = await h.api.vaultCreate('password', secret);
  assert.equal(meta.password.iter, 600000);
  h.api.setState(session, [session], { privateKey: 'gas-private-key' });
  await h.api.persist();
  assert.deepEqual(Object.keys(h.data), ['vaultData']);
  assert(!JSON.stringify(h.data).includes('secret-note'));
  assert(!JSON.stringify(h.data).includes('private-key'));
  h.api.vaultForget();
  h.api.setMeta(meta);
  await assert.rejects(h.api.vaultUnlock('password', 'wrong password'), { code: 'BAD_SECRET' });
  assert.equal(h.api.vault.unlocked, false);
  await h.api.vaultUnlock('password', secret);
  assert.deepEqual(plain(await h.api.vaultOpen(h.data.vaultData)), {
    active: session, history: [session], gasWallet: { privateKey: 'gas-private-key' },
  });
  await assert.rejects(h.api.vaultVerify('password', 'wrong password'), { code: 'BAD_SECRET' });
  await h.api.vaultVerify('password', secret);
});

test('authenticated ciphertext rejects tampering and uses a new nonce for each save', async () => {
  const h = harness();
  await h.api.vaultCreate('password', secret);
  const a = await h.api.vaultSeal(session), b = await h.api.vaultSeal(session);
  assert.notEqual(a.iv, b.iv);
  const bytes = Buffer.from(a.ct, 'base64'); bytes[0] ^= 1;
  await assert.rejects(h.api.vaultOpen({ ...a, ct: bytes.toString('base64') }));
});

test('encrypted app writes serialize call-time snapshots and never fall back to plaintext when locked', async () => {
  const h = harness();
  const meta = await h.api.vaultCreate('password', secret);
  const state = structuredClone(session);
  h.api.setState(state);
  const first = h.api.persist();
  state.mix.notes[0].depositIntent.raw = 'new-signed-transaction';
  const second = h.api.persist();
  await Promise.all([first, second]);
  const snapshots = await Promise.all(h.writes.map((write) => h.api.vaultOpen(write.vaultData)));
  assert.equal(snapshots[0].active.mix.notes[0].depositIntent.raw, 'signed-transaction');
  assert.equal(snapshots[1].active.mix.notes[0].depositIntent.raw, 'new-signed-transaction');
  h.api.vaultForget(); h.api.setMeta(meta);
  await assert.rejects(h.api.persist(), /locked/);
  assert.deepEqual(Object.keys(h.data), ['vaultData']);
  await h.api.vaultUnlock('password', secret);
  await h.api.persist();
});

test('legacy migration removes plaintext only after complete encrypted data and metadata are durable', async () => {
  const h = harness();
  Object.assign(h.data, { active: session, history: [session], gasWallet: { privateKey: 'gas-key' } });
  h.api.setState(session, [session], h.data.gasWallet);
  await h.api.secureWith('password', secret);
  assert.deepEqual(Object.keys(h.data).sort(), ['vaultData', 'vaultMeta']);
  assert.deepEqual(plain((await h.api.vaultOpen(h.data.vaultData)).active), session);
  assert.equal(h.api.getSecurityBusy(), false);
  const blocked = harness();
  blocked.api.setBusy(true);
  await blocked.api.secureWith('password', secret);
  assert.deepEqual(Object.keys(blocked.data), []);
  assert.equal(blocked.api.vault.enabled, false);
});

test('migration storage failure keeps legacy data and does not enable a half-written vault', async () => {
  const h = harness();
  h.api.setState(session);
  h.data.active = session;
  vm.runInContext("chrome.storage.local.set = async () => { throw new Error('disk full'); };", h.context);
  await h.api.secureWith('password', secret);
  assert.deepEqual(h.data.active, session);
  assert.equal(h.data.vaultMeta, undefined);
  assert.equal(h.api.vault.enabled, false);
  assert.equal(h.api.getSecurityBusy(), false);
});


test('adding an unlock method requires current authentication and cancellation keeps metadata unchanged', async () => {
  const h = harness();
  h.data.vaultMeta = await h.api.vaultCreate('password', secret);
  vm.runInContext(`
    this.methodAdds = 0;
    reauth = async () => false;
    vaultAddMethod = async () => { methodAdds++; return vault.meta; };
  `, h.context);
  await h.api.secureWith('password', 'untrusted-new-password');
  assert.equal(h.context.methodAdds, 0);
  assert.equal(h.api.getSecurityBusy(), false);
  vm.runInContext('reauth = async () => true;', h.context);
  await h.api.secureWith('password', 'verified-new-password');
  assert.equal(h.context.methodAdds, 1);
});

test('concurrent unlock attempts cannot replace an active Tornado session with an older snapshot', async () => {
  const h = harness();
  h.data.vaultMeta = await h.api.vaultCreate('password', secret);
  h.data.vaultData = await h.api.vaultSeal({ active: session, history: [] });
  h.context.unlockCalls = 0;
  h.context.startCalls = 0;
  vm.runInContext(`
    vaultUnlock = async () => { unlockCalls++; await new Promise(resolve => setTimeout(resolve, 10)); };
    startApp = async () => { startCalls++; appReady = true; };
  `, h.context);
  await Promise.all([h.api.unlock('password'), h.api.unlock('password')]);
  await h.api.unlock('password');
  assert.equal(h.context.unlockCalls, 1);
  assert.equal(h.context.startCalls, 1);
  assert.equal(h.api.getSecurityBusy(), false);
});
