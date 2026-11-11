'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Flow = require('../extension/tornado-flow.js');

const address = (n) => '0x' + n.toString(16).padStart(40, '0');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');

function harness(options = {}) {
  const session = { dest: address(1), secondWallet: { address: address(2) } };
  const ledger = new Map();
  let sequence = 100;
  const h = { session, ledger, saved: null, deposits: 0, withdrawals: 0, finalizes: 0,
    hold: !!options.hold, balance: options.balance ?? 25n, finalPending: !!options.finalPending };
  const adapter = {
    pools: async () => [{ address: address(3), amount: '10', denomination: '0.1' }],
    balance: async () => h.balance,
    prepareNote: async () => ({ note: 'secret-' + sequence, commitment: hash(sequence++), nullifierHash: hash(sequence++) }),
    save: async (s) => { h.saved = JSON.parse(JSON.stringify(s)); },
    deposit: async (n, s) => {
      assert.equal(h.saved.mix.notes.find((x) => x.id === n.id).status, 'deposit_pending');
      assert.equal(h.saved.mix.notes.find((x) => x.id === n.id).note, n.note);
      h.deposits++;
      const deposit = { status: 'confirmed', txHash: hash(sequence++) };
      ledger.set(n.id, { deposit });
      return deposit;
    },
    reconcile: async (n) => ledger.get(n.id) || { deposit: { status: 'absent' } },
    withdraw: async (n, s) => {
      assert.equal(h.saved.mix.notes.find((x) => x.id === n.id).status, 'withdraw_pending');
      h.withdrawals++;
      const withdrawal = h.hold && h.withdrawals === 2 ? { status: 'pending' } :
        { status: 'confirmed', txHash: hash(sequence++), recipient: s.secondWallet.address, amount: '9' };
      ledger.get(n.id).withdrawal = withdrawal;
      return withdrawal;
    },
    secondBalance: async () => [...ledger.values()].reduce((sum, x) => sum +
      (x.withdrawal && x.withdrawal.status === 'confirmed' ? BigInt(x.withdrawal.amount) : 0n), 0n),
    finalize: async (s) => {
      assert.equal(h.saved.mix.phase, 'finalizing');
      assert.ok(h.saved.mix.notes.every((n) => n.status === 'withdrawn'));
      h.finalizes++;
      h.finalResult = h.finalPending ? { status: 'pending', txHash: hash(sequence++) } :
        { status: 'confirmed', txHash: hash(sequence++), recipient: s.dest, amount: '17' };
      return h.finalResult;
    },
    reconcileFinalization: async () => h.finalResult,
  };
  h.adapter = adapter;
  h.tick = () => Flow.tick(h.session, adapter);
  h.drive = async (count = 20) => { for (let i = 0; i < count && h.session.mix?.phase !== 'done'; i++) await h.tick(); };
  return h;
}

test('plans largest denominations with exact bigint arithmetic and leaves remainder', () => {
  const result = Flow.planBalance(123456789012345678901n, [
    { address: address(3), amount: '100000000000000000000' },
    { address: address(4), amount: '10000000000000000000' },
    { address: address(5), amount: '1000000000000000000' },
  ]);
  assert.equal(result.plan.length, 6);
  assert.equal(result.plannedWei, '123000000000000000000');
  assert.equal(result.remainingWei, '456789012345678901');
});

test('caps a batch at 100 notes without transferring the excess', () => {
  const result = Flow.planBalance(1001n, [{ address: address(3), amount: '10' }]);
  assert.equal(result.plan.length, 100);
  assert.equal(result.remainingWei, '1');
  const capped = Flow.planBalance(2001n, [{ address: address(3), amount: '10' }]);
  assert.equal(capped.plan.length, 100);
  assert.equal(capped.remainingWei, '1001');
  assert.equal(capped.limitReached, true);
});

test('freezes the first eligible balance; later deposits stay in the first wallet', async () => {
  const h = harness();
  await h.tick();
  h.balance = 1000n;
  await h.drive();
  assert.equal(h.session.mix.snapshotWei, '25');
  assert.equal(h.session.mix.remainingWei, '5');
  assert.equal(h.deposits, 2);
  assert.equal(h.finalizes, 1);
  assert.equal(h.session.phase, 'done');
});

test('never transfers B while one of two withdrawals remains pending', async () => {
  const h = harness({ hold: true });
  await h.drive(10);
  assert.equal(h.withdrawals, 2);
  assert.equal(h.finalizes, 0);
  assert.equal(h.session.mix.counts.withdrawn, 1);
  assert.equal(h.session.mix.counts.withdrawPending, 1);
  const note = h.session.mix.notes[1];
  h.ledger.get(note.id).withdrawal = { status: 'confirmed', recipient: address(2), amount: '9', txHash: hash(500) };
  await h.drive();
  assert.equal(h.finalizes, 1);
  assert.equal(h.session.mix.expectedReceivedWei, '18');
});

test('restart reconciles a broadcast deposit instead of creating another deposit', async () => {
  const h = harness({ balance: 10n });
  const originalDeposit = h.adapter.deposit;
  h.adapter.deposit = async (n, s) => { await originalDeposit(n, s); throw new Error('connection lost after broadcast'); };
  await assert.rejects(h.tick(), /connection lost/);
  assert.equal(h.deposits, 1);
  h.session = JSON.parse(JSON.stringify(h.saved));
  h.adapter.deposit = originalDeposit;
  await h.drive();
  assert.equal(h.deposits, 1);
  assert.equal(h.finalizes, 1);
});

test('rejects a withdrawal sent to any recipient except the second wallet', async () => {
  const h = harness({ balance: 10n });
  await h.tick();
  const original = h.adapter.withdraw;
  h.adapter.withdraw = async (n, s) => ({ ...await original(n, s), recipient: address(9) });
  await assert.rejects(h.tick(), { code: 'mixWrongRecipient' });
  assert.equal(h.finalizes, 0);
  assert.equal(h.session.mix.notes[0].status, 'withdraw_pending');
});

test('does not treat isSpent or a missing Withdrawal log as receipt proof', async () => {
  const h = harness({ balance: 10n });
  await h.tick();
  await h.tick();
  h.session = JSON.parse(JSON.stringify(h.saved));
  h.adapter.reconcile = async () => ({ isSpent: true });
  await h.drive(4);
  assert.equal(h.finalizes, 0);
  assert.equal(h.session.mix.notes[0].status, 'withdraw_pending');
});

test('insufficient denomination waits and never deposits or sweeps', async () => {
  const h = harness({ balance: 9n });
  await h.drive(3);
  assert.equal(h.session.mix.phase, 'waiting');
  assert.equal(h.session.mix.remainingWei, '9');
  assert.equal(h.deposits, 0);
  assert.equal(h.finalizes, 0);
  h.balance = 15n;
  await h.drive();
  assert.equal(h.deposits, 1);
  assert.equal(h.session.mix.remainingWei, '5');
});

test('a pending final transfer is reconciled without sending twice across restart', async () => {
  const h = harness({ finalPending: true });
  await h.drive(8);
  assert.equal(h.finalizes, 1);
  assert.equal(h.session.mix.phase, 'finalizing');
  h.session = JSON.parse(JSON.stringify(h.saved));
  await h.drive(4);
  assert.equal(h.finalizes, 1);
  h.finalResult = { ...h.finalResult, status: 'confirmed', recipient: address(1), amount: '17' };
  await h.drive();
  assert.equal(h.finalizes, 1);
  assert.equal(h.session.phase, 'done');
});

test('failed storage writes prevent all transaction calls', async () => {
  const h = harness();
  h.adapter.save = async () => { throw new Error('disk full'); };
  await assert.rejects(h.tick(), /disk full/);
  assert.equal(h.deposits, 0);
  assert.equal(h.withdrawals, 0);
  assert.equal(h.finalizes, 0);
});

test('confirmed net balance must cover every withdrawal before the sweep', async () => {
  const h = harness();
  h.adapter.secondBalance = async () => 17n;
  await h.drive(10);
  assert.equal(h.session.mix.counts.withdrawn, 2);
  assert.equal(h.session.mix.phase, 'collecting');
  assert.equal(h.finalizes, 0);
  h.adapter.secondBalance = async () => 18n;
  await h.drive();
  assert.equal(h.finalizes, 1);
});

test('canonical receipt recheck catches a withdrawn-note reorg before the sweep', async () => {
  const h = harness({ balance: 10n });
  await h.tick();
  await h.tick();
  const note = h.session.mix.notes[0];
  h.ledger.get(note.id).withdrawal = { status: 'pending' };
  await h.tick();
  assert.equal(h.finalizes, 0);
  assert.equal(note.status, 'withdraw_pending');
});
