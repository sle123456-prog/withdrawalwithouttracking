'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../extension/vendor/ethers.umd.min.js');
globalThis.ethers = E;
const Adapter = require('../extension/tornado-adapter.js');

const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const wallet = (n) => new E.Wallet(hash(n));
const poolAddress = '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc';
const iface = new E.Interface(Adapter.POOL_ABI);

function harness() {
  const first = wallet(1);
  const second = wallet(2);
  const destination = wallet(3);
  const note = { id: 'note1', note: 'private-note', commitment: hash(4), nullifierHash: hash(5),
    pool: { address: poolAddress, amount: E.parseEther('0.1').toString(), denomination: '0.1',
      currency: 'eth', decimals: 18, chainId: 1, deployedBlock: 1 }, amount: E.parseEther('0.1').toString(), status: 'deposit_pending' };
  const h = { head: 110, broadcasts: [], nonceReads: 0, receipts: new Map(), canonical: hash(100), saved: null,
    session: { address: first.address, privateKey: first.privateKey, secondWallet: { address: second.address, privateKey: second.privateKey },
      dest: destination.address, chainId: 1, asset: 'native', mix: { notes: [note], expectedReceivedWei: E.parseEther('1').toString() } } };
  const provider = {
    getTransactionCount: async () => { h.nonceReads++; return 7; },
    getBalance: async () => E.parseEther('10'),
    getCode: async () => '0x',
    getFeeData: async () => ({ gasPrice: 1000000000n }),
    getBlockNumber: async () => h.head,
    getBlock: async () => ({ hash: h.canonical }),
    getTransactionReceipt: async (txHash) => h.receipts.get(txHash) || null,
    getTransaction: async () => ({}),
    getLogs: async () => h.logs || [],
    call: async (request) => {
      const parsed = iface.parseTransaction({ data: request.data });
      const name = parsed.name;
      let result;
      if (name === 'isSpent') result = !!h.spent;
      else if (name === 'isKnownRoot') result = !h.expired || parsed.args[0] !== hash(600);
      else if (name === 'nextIndex') result = 1;
      else throw new Error('Unhandled mocked contract call: ' + name);
      return iface.encodeFunctionResult(name, [result]);
    },
    estimateGas: async () => 1000000n,
    broadcastTransaction: async (raw) => {
      const saved = JSON.stringify(h.saved);
      assert.ok(saved.includes(raw), 'signed transaction must be durable before broadcast');
      assert.ok(saved.includes(E.keccak256(raw)), 'expected hash must be durable before broadcast');
      h.broadcasts.push(raw);
      if (h.broadcastError) throw new Error(h.broadcastError);
      return E.Transaction.from(raw);
    },
  };
  h.provider = provider;
  h.config = () => ({ session: h.session, provider, storage: { get: async () => h.cache || null, set: async () => {} },
    chain: { id: 1 }, getGasPrice: async () => 1000000000n,
    save: async (s) => { if (h.storageError) throw new Error('storage unavailable'); h.saved = JSON.parse(JSON.stringify(s)); } });
  h.adapter = () => Adapter.create(h.config());
  h.note = () => h.session.mix.notes[0];
  h.depositReceipt = (commitment = note.commitment) => {
    const tx = E.Transaction.from(h.broadcasts[0]);
    const encoded = iface.encodeEventLog(iface.getEvent('Deposit'), [commitment, 0, 123]);
    const receipt = { hash: tx.hash, from: tx.from, to: tx.to, status: 1, blockNumber: 100,
      blockHash: hash(100), logs: [{ address: poolAddress, ...encoded }] };
    h.receipts.set(tx.hash, receipt);
    return receipt;
  };
  return h;
}

test('journals an actual signed transaction and rebroadcasts the identical raw bytes after restart', async () => {
  const h = harness();
  h.broadcastError = 'process crash after sending';
  await assert.rejects(h.adapter().deposit(h.note()), /process crash/);
  assert.equal(h.broadcasts.length, 1);
  const originalRaw = h.broadcasts[0];
  const decoded = E.Transaction.from(originalRaw);
  assert.equal(decoded.from, h.session.address);
  assert.equal(decoded.chainId, 1n);
  assert.equal(decoded.to, E.getAddress(poolAddress));
  assert.equal(decoded.value, E.parseEther('0.1'));
  assert.equal(iface.parseTransaction({ data: decoded.data }).args[0], h.note().commitment);
  h.session = JSON.parse(JSON.stringify(h.saved));
  h.note().operations.deposit[0].lastBroadcastAt = 0;
  h.broadcastError = null;
  const result = await h.adapter().reconcile(h.note());
  assert.equal(result.deposit.status, 'pending');
  assert.equal(h.broadcasts.length, 2);
  assert.equal(h.broadcasts[1], originalRaw);
  assert.equal(h.nonceReads, 1, 'recovery must not select another nonce or sign a new deposit');
});

test('storage failure before broadcast sends no transaction', async () => {
  const h = harness();
  h.storageError = true;
  await assert.rejects(h.adapter().deposit(h.note()), /storage unavailable/);
  assert.equal(h.broadcasts.length, 0);
});

test('native planning reserves enough gas after one large denomination becomes many small notes', async () => {
  const h = harness();
  globalThis.TornadoPools = require('../extension/tornado-pools.js');
  h.provider.getBalance = async () => E.parseEther('100');
  const config = h.config();
  const gasPrice = 20000000000n;
  config.getGasPrice = async () => gasPrice;
  const adapter = Adapter.create(config);
  const Flow = require('../extension/tornado-flow.js');
  const plan = Flow.planBalance(await adapter.balance(), await adapter.pools());
  assert.ok(plan.plan.length > 1);
  assert.ok(BigInt(plan.plannedWei) + BigInt(plan.plan.length) * 1400000n * gasPrice <= E.parseEther('100'));
});

test('receipt waits for twelve confirmations and checks its canonical block hash', async () => {
  const h = harness();
  await h.adapter().deposit(h.note());
  const rc = h.depositReceipt();
  assert.equal((await h.adapter().reconcile(h.note())).deposit.status, 'pending');
  h.head = 111;
  h.canonical = hash(999);
  assert.equal((await h.adapter().reconcile(h.note())).deposit.status, 'pending');
  h.canonical = rc.blockHash;
  const result = await h.adapter().reconcile(h.note());
  assert.equal(result.deposit.status, 'confirmed');
  assert.equal(h.note().leafIndex, 0);
  assert.equal(h.note().depositBlock, 100);
  assert.equal(h.nonceReads, 1);
});

test('a confirmed transaction without this exact note commitment is not a deposit', async () => {
  const h = harness();
  await h.adapter().deposit(h.note());
  h.depositReceipt(hash(999));
  h.head = 111;
  await assert.rejects(h.adapter().reconcile(h.note()), /mixDepositEventMissing/);
});

test('a pending final sweep reuses one signed transaction and only completes on a canonical receipt', async () => {
  const h = harness();
  const result = await h.adapter().finalize();
  assert.equal(result.status, 'pending');
  const raw = h.broadcasts[0];
  const tx = E.Transaction.from(raw);
  assert.equal(tx.from, h.session.secondWallet.address);
  assert.equal(tx.to, h.session.dest);
  assert.ok(tx.value < E.parseEther('10'));
  h.session = JSON.parse(JSON.stringify(h.saved));
  h.session.mix.operations.finalization[0].lastBroadcastAt = 0;
  await h.adapter().reconcileFinalization();
  assert.equal(h.broadcasts[1], raw);
  assert.equal(h.nonceReads, 1);
  h.head = 111;
  h.receipts.set(tx.hash, { hash: tx.hash, from: tx.from, to: tx.to, status: 1,
    blockNumber: 100, blockHash: hash(100), logs: [] });
  const confirmed = await h.adapter().reconcileFinalization();
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.recipient, h.session.dest);
  assert.equal(confirmed.amount, tx.value.toString());
});

test('finalization never marks an on-chain revert as complete', async () => {
  const h = harness();
  await h.adapter().finalize();
  const tx = E.Transaction.from(h.broadcasts[0]);
  h.head = 111;
  h.receipts.set(tx.hash, { hash: tx.hash, from: tx.from, to: tx.to, status: 0,
    blockNumber: 100, blockHash: hash(100), logs: [] });
  await assert.rejects(h.adapter().reconcileFinalization(), /mixTransactionReverted/);
  for (let tick = 0; tick < 4; tick++) {
    await assert.rejects(h.adapter().reconcileFinalization(), /mixTransactionReverted/);
    await assert.rejects(h.adapter().finalize(), /mixTransactionReverted/);
  }
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.nonceReads, 1);
  assert.equal(h.session.phase, undefined);
});

test('a confirmed reverted deposit never signs a replacement or repeatedly charges gas', async () => {
  const h = harness();
  await h.adapter().deposit(h.note());
  const rc = h.depositReceipt();
  rc.status = 0;
  h.head = 111;
  await assert.rejects(h.adapter().reconcile(h.note()), /mixTransactionReverted/);
  h.session = JSON.parse(JSON.stringify(h.saved));
  for (let tick = 0; tick < 4; tick++) {
    await assert.rejects(h.adapter().reconcile(h.note()), /mixTransactionReverted/);
    await assert.rejects(h.adapter().deposit(h.note()), /mixTransactionReverted/);
  }
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.nonceReads, 1);
});

function withdrawalHarness({ expired = false } = {}) {
  const h = harness();
  h.head = 111;
  h.expired = expired;
  const note = h.note();
  note.status = 'withdraw_pending';
  note.leafIndex = 0;
  note.depositBlock = 90;
  const oldRelayer = { address: wallet(6).address, url: 'https://old.example/' };
  const newRelayer = { address: wallet(7).address, url: 'https://new.example/' };
  note.withdrawalIntent = { id: 'old-job', relayer: oldRelayer, fee: '1', refund: '0',
    proof: '0x' + 'ff'.repeat(256), args: [hash(600), note.nullifierHash, h.session.secondWallet.address,
      oldRelayer.address, '0x01', '0x00'], submittedAt: 1, status: 'prepared' };
  h.cache = { version: 1, toBlock: 100, blockHash: hash(100), leaves: [note.commitment] };
  h.submissions = [];
  globalThis.TornadoCrypto = {
    prove: async ({ note: secret, recipient, relayer, fee, refund }) => {
      assert.equal(secret, note.note);
      return { proof: '0x' + 'aa'.repeat(256), args: [hash(601), note.nullifierHash, recipient, relayer,
        '0x' + BigInt(fee).toString(16), '0x' + BigInt(refund).toString(16)] };
    },
  };
  globalThis.TornadoRelayer = {
    select: async () => newRelayer,
    quote: async () => ({ fee: '2', refund: '0' }),
    job: async () => { if (h.expired) throw new Error('Old relayer is offline'); return { status: 'FAILED' }; },
    submit: async (payload) => { assert.equal(payload.note, undefined); h.submissions.push(payload); return { id: 'new-job' }; },
  };
  h.oldRelayer = oldRelayer;
  return h;
}

test('a failed relayer job regenerates a current proof without losing a late previous payout', async () => {
  const h = withdrawalHarness();
  assert.equal((await h.adapter().reconcile(h.note())).withdrawal.status, 'pending');
  assert.equal(h.submissions.length, 1);
  assert.equal(h.note().withdrawalIntent.id, 'new-job');
  assert.equal(h.note().withdrawalAttempts[0].id, 'old-job');
  const encoded = iface.encodeEventLog(iface.getEvent('Withdrawal'),
    [h.session.secondWallet.address, h.note().nullifierHash, h.oldRelayer.address, 1n]);
  const txHash = hash(888);
  const log = { address: poolAddress, ...encoded, transactionHash: txHash, blockNumber: 100 };
  h.spent = true;
  h.logs = [log];
  h.receipts.set(txHash, { hash: txHash, status: 1, blockNumber: 100, blockHash: hash(100), logs: [log] });
  const confirmed = (await h.adapter().reconcile(h.note())).withdrawal;
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.fee, '1');
  assert.equal(confirmed.amount, (BigInt(h.note().amount) - 1n).toString());
});

test('an expired proof can move to a healthy relayer while its original endpoint is offline', async () => {
  const h = withdrawalHarness({ expired: true });
  assert.equal((await h.adapter().reconcile(h.note())).withdrawal.status, 'pending');
  assert.equal(h.submissions.length, 1);
  assert.equal(h.note().withdrawalIntent.args[0], hash(601));
});

test('a repeatedly offline relayer can be replaced while the old root is still valid', async () => {
  const h = withdrawalHarness();
  globalThis.TornadoRelayer.job = async () => { throw new Error('Relayer is offline'); };
  await assert.rejects(h.adapter().reconcile(h.note()), /Relayer is offline/);
  await assert.rejects(h.adapter().reconcile(h.note()), /Relayer is offline/);
  const result = await h.adapter().reconcile(h.note());
  assert.equal(result.withdrawal.status, 'pending');
  assert.equal(h.submissions.length, 1);
  assert.equal(h.note().withdrawalAttempts[0].id, 'old-job');
});

const tokenIface = new E.Interface(Adapter.TOKEN_ABI);
function tokenHarness() {
  const h = harness();
  h.head = 111;
  h.session.asset = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  h.session.mix.expectedReceivedWei = '100000000';
  Object.assign(h.note().pool, { address: '0xd96f2B1c14Db8458374d9Aca76E26c3D18364307',
    amount: '100000000', denomination: '100', currency: 'usdc', decimals: 6 });
  h.note().amount = '100000000';
  h.allowance = 0n;
  h.firstNative = E.parseEther('1');
  h.secondNative = 0n;
  h.secondTokens = 100000000n;
  const oldCall = h.provider.call;
  h.provider.call = async (request) => {
    if (String(request.to).toLowerCase() !== h.session.asset.toLowerCase()) return oldCall(request);
    const parsed = tokenIface.parseTransaction({ data: request.data });
    let value;
    if (parsed.name === 'allowance') value = h.allowance;
    else if (parsed.name === 'balanceOf') value = parsed.args[0] === h.session.secondWallet.address ? h.secondTokens : 100000000n;
    else throw new Error('Unhandled token mock call ' + parsed.name);
    return tokenIface.encodeFunctionResult(parsed.name, [value]);
  };
  h.provider.getBalance = async (address) => address === h.session.address ? h.firstNative :
    address === h.session.secondWallet.address ? h.secondNative : E.parseEther('10');
  h.confirm = (raw, logs = []) => {
    const tx = E.Transaction.from(raw);
    h.receipts.set(tx.hash, { hash: tx.hash, from: tx.from, to: tx.to, status: 1,
      blockNumber: 100, blockHash: hash(100), logs });
    return tx;
  };
  return h;
}

test('ERC20 gas funding remains recoverable after the user removes the Gas wallet', async () => {
  const h = tokenHarness();
  h.firstNative = 0n;
  const gw = wallet(9);
  const config = h.config();
  config.gasWallet = { privateKey: gw.privateKey, address: gw.address };
  assert.equal((await Adapter.create(config).deposit(h.note())).status, 'pending');
  assert.equal(E.Transaction.from(h.broadcasts[0]).from, gw.address);
  h.confirm(h.broadcasts[0]);
  h.firstNative = E.parseEther('1');
  const result = await h.adapter().reconcile(h.note());
  assert.equal(result.deposit.status, 'pending');
  assert.equal(h.broadcasts.length, 2);
  const approval = E.Transaction.from(h.broadcasts[1]);
  assert.equal(approval.from, h.session.address);
  assert.equal(tokenIface.parseTransaction({ data: approval.data }).name, 'approve');
  assert.equal(h.note().funding[0].operations.funding[0].status, 'confirmed');
});

test('ERC20 uses zero-first then exact approval and validates the final deposit Transfer', async () => {
  const h = tokenHarness();
  h.allowance = 1n;
  await h.adapter().deposit(h.note());
  let tx = h.confirm(h.broadcasts[0]);
  assert.equal(tokenIface.parseTransaction({ data: tx.data }).args[1], 0n);
  h.allowance = 0n;
  await h.adapter().reconcile(h.note());
  tx = h.confirm(h.broadcasts[1]);
  assert.equal(tokenIface.parseTransaction({ data: tx.data }).args[1], 100000000n);
  h.allowance = 100000000n;
  assert.equal((await h.adapter().reconcile(h.note())).deposit.status, 'absent');
  await h.adapter().deposit(h.note());
  tx = E.Transaction.from(h.broadcasts[2]);
  assert.equal(tx.value, 0n);
  assert.equal(iface.parseTransaction({ data: tx.data }).name, 'deposit');
  const deposit = iface.encodeEventLog(iface.getEvent('Deposit'), [h.note().commitment, 0, 123]);
  const transfer = tokenIface.encodeEventLog(tokenIface.getEvent('Transfer'),
    [h.session.address, h.note().pool.address, 100000000n]);
  h.confirm(h.broadcasts[2], [{ address: h.note().pool.address, ...deposit }, { address: h.session.asset, ...transfer }]);
  assert.equal((await h.adapter().reconcile(h.note())).deposit.status, 'confirmed');
});

test('ERC20 final sweep never funds wallet 2 from the Gas wallet and waits for native refund', async () => {
  const h = tokenHarness();
  const config = h.config();
  config.gasWallet = { privateKey: wallet(9).privateKey, address: wallet(9).address };
  await assert.rejects(Adapter.create(config).finalize(), /mixSecondGasLow/);
  assert.equal(h.broadcasts.length, 0);
  h.secondNative = E.parseEther('1');
  await h.adapter().finalize();
  assert.equal(h.broadcasts.length, 1);
  const tx = E.Transaction.from(h.broadcasts[0]);
  assert.equal(tx.from, h.session.secondWallet.address);
  assert.equal(tx.to, E.getAddress(h.session.asset));
  const parsed = tokenIface.parseTransaction({ data: tx.data });
  assert.equal(parsed.args[0], h.session.dest);
  assert.equal(parsed.args[1], 100000000n);
  const transfer = tokenIface.encodeEventLog(tokenIface.getEvent('Transfer'),
    [h.session.secondWallet.address, h.session.dest, 100000000n]);
  h.confirm(h.broadcasts[0], [{ address: h.session.asset, ...transfer }]);
  const result = await h.adapter().reconcileFinalization();
  assert.equal(result.status, 'confirmed');
  assert.equal(result.amount, '100000000');
});

for (const operation of ['funding', 'approval']) {
  test(`a confirmed reverted ${operation} pauses the entire pipeline across repeated ticks`, async () => {
    const h = tokenHarness();
    const config = h.config();
    if (operation === 'funding') {
      h.firstNative = 0n;
      config.gasWallet = { privateKey: wallet(9).privateKey, address: wallet(9).address };
    }
    await Adapter.create(config).deposit(h.note());
    const tx = h.confirm(h.broadcasts[0]);
    h.receipts.get(tx.hash).status = 0;
    await assert.rejects(Adapter.create(config).reconcile(h.note()), /mixTransactionReverted/);
    h.session = JSON.parse(JSON.stringify(h.saved));
    for (let tick = 0; tick < 4; tick++) {
      await assert.rejects(h.adapter().reconcile(h.note()), /mixTransactionReverted/);
      await assert.rejects(h.adapter().deposit(h.note()), /mixTransactionReverted/);
    }
    assert.equal(h.broadcasts.length, 1);
    assert.equal(h.nonceReads, 1);
  });
}

test('a full Tornado Merkle tree stops a new deposit before signing or funding', async () => {
  const h = harness();
  const originalCall = h.provider.call;
  h.provider.call = async (request) => {
    const parsed = iface.parseTransaction({ data: request.data });
    return parsed.name === 'nextIndex' ? iface.encodeFunctionResult('nextIndex', [2 ** 20]) : originalCall(request);
  };
  await assert.rejects(h.adapter().deposit(h.note()), /mixPoolFull/);
  assert.equal(h.broadcasts.length, 0);
  assert.equal(h.nonceReads, 0);
});
