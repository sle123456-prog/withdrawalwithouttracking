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

async function completedHarness() {
  const h = harness({ balance: 15n });
  h.session.address = address(4);
  h.prepared = 0;
  const prepare = h.adapter.prepareNote;
  h.adapter.prepareNote = async (...args) => { h.prepared++; return prepare(...args); };
  // Only this round's canonical receipts represent its collected funds. The
  // previous round has already been swept when a new round begins.
  h.adapter.secondBalance = async (s) => s.mix.notes.reduce((sum, n) => {
    const receipt = h.ledger.get(n.id)?.withdrawal;
    return sum + (receipt?.status === 'confirmed' ? BigInt(receipt.amount) : 0n);
  }, 0n);
  const finalize = h.adapter.finalize;
  h.adapter.finalize = async (s) => {
    const result = await finalize(s);
    result.amount = ((await h.adapter.secondBalance(s)) - 1n).toString();
    return result;
  };
  await h.drive();
  assert.equal(h.session.mix.phase, 'done');
  h.balance = 5n;
  return h;
}

test('a completed round keeps watching an insufficient remainder without archiving or paying again', async () => {
  const h = await completedHarness();
  const completed = h.session.mix;
  completed.sourceBalanceWei = '15';
  completed.nativeReserveWei = '2';
  const snapshot = JSON.parse(JSON.stringify(completed));
  h.adapter.balance = async (s) => {
    s.mix.sourceBalanceWei = '7';
    s.mix.nativeReserveWei = '1';
    return h.balance;
  };
  for (let i = 0; i < 4; i++) await h.tick();
  assert.equal(h.session.mix, completed);
  assert.deepEqual(completed, snapshot);
  assert.equal(h.session.mixHistory, undefined);
  assert.equal(h.prepared, 1);
  assert.equal(h.deposits, 1);
  assert.equal(h.withdrawals, 1);
  assert.equal(h.finalizes, 1);
});

test('later eligible funds start one durable new round and retain every old note and signed receipt', async (t) => {
  t.mock.method(Date, 'now', () => 123456);
  const h = await completedHarness();
  const completed = h.session.mix;
  const firstId = completed.notes[0].id;
  completed.notes[0].operations = { deposit: [{ raw: 'original signed bytes', hash: hash(800) }] };
  completed.finalization.raw = 'original final transfer bytes';
  const snapshot = JSON.parse(JSON.stringify(completed));
  const originalFirst = h.session.address;
  const originalSecond = h.session.secondWallet;
  h.balance = 10n;
  await h.tick();
  assert.equal(h.session.mixHistory.length, 1);
  assert.equal(h.session.mixHistory[0], completed);
  assert.deepEqual(h.saved.mixHistory[0], snapshot);
  assert.equal(h.session.mix.round, 2);
  assert.equal(h.session.mix.phase, 'waiting');
  assert.equal(h.session.phase, 'waiting');
  assert.equal(h.session.mix.snapshotWei, undefined);
  assert.equal(h.session.mix.notes.length, 0);
  assert.equal(h.prepared, 1, 'The rollover tick must only persist the handoff');
  assert.equal(h.deposits, 1);
  assert.equal(h.finalizes, 1);

  await h.drive();
  assert.equal(h.prepared, 2);
  assert.equal(h.deposits, 2);
  assert.equal(h.withdrawals, 2);
  assert.equal(h.finalizes, 2);
  assert.equal(h.session.mixHistory.length, 1);
  assert.deepEqual(h.session.mixHistory[0], snapshot);
  assert.equal(h.session.address, originalFirst);
  assert.equal(h.session.secondWallet, originalSecond);
  assert.notEqual(h.session.mix.notes[0].id, firstId, 'Round IDs must differ even within the same millisecond');
  assert.equal(h.session.mix.createdAt, completed.createdAt);
  h.balance = 0n;
  await h.tick();
  assert.equal(h.session.mixHistory.length, 1);
  assert.equal(h.finalizes, 2);
});

test('a failed rollover save restores the old round and retries without duplicate history or transactions', async () => {
  const h = await completedHarness();
  const completed = h.session.mix;
  const oldNotes = JSON.parse(JSON.stringify(completed.notes));
  const save = h.adapter.save;
  h.balance = 10n;
  h.adapter.save = async () => { throw new Error('storage unavailable during rollover'); };
  await assert.rejects(h.tick(), /storage unavailable/);
  assert.equal(h.session.mix, completed);
  assert.equal(h.session.phase, 'done');
  assert.equal(h.session.mixHistory, undefined);
  assert.deepEqual(h.session.mix.notes, oldNotes);
  assert.equal(h.prepared, 1);
  assert.equal(h.deposits, 1);
  assert.equal(h.finalizes, 1);

  h.adapter.save = save;
  await h.tick();
  assert.equal(h.session.mixHistory.length, 1);
  assert.equal(h.prepared, 1);
  h.session = JSON.parse(JSON.stringify(h.saved));
  await h.drive();
  assert.equal(h.session.mixHistory.length, 1);
  assert.deepEqual(h.session.mixHistory[0].notes, oldNotes);
  assert.equal(h.prepared, 2);
  assert.equal(h.deposits, 2);
  assert.equal(h.finalizes, 2);
});

test('restart after an uncertain rollover write resumes the persisted new round without archiving twice', async () => {
  const h = await completedHarness();
  const oldNotes = JSON.parse(JSON.stringify(h.session.mix.notes));
  const save = h.adapter.save;
  let first = true;
  h.balance = 10n;
  h.adapter.save = async (s) => {
    if (first) {
      first = false;
      await save(s); // The write reached storage, but its acknowledgement was lost.
    }
    throw new Error('lost storage acknowledgement');
  };
  await assert.rejects(h.tick(), /lost storage acknowledgement/);
  assert.equal(h.session.mix.phase, 'done');
  assert.equal(h.saved.mix.phase, 'waiting');
  assert.equal(h.saved.mixHistory.length, 1);
  assert.equal(h.prepared, 1);
  assert.equal(h.deposits, 1);

  h.adapter.save = save;
  h.session = JSON.parse(JSON.stringify(h.saved));
  await h.drive();
  assert.equal(h.session.mixHistory.length, 1);
  assert.deepEqual(h.session.mixHistory[0].notes, oldNotes);
  assert.equal(h.session.mix.round, 2);
  assert.equal(h.prepared, 2);
  assert.equal(h.deposits, 2);
  assert.equal(h.finalizes, 2);
});

test('a completed legacy round without a round number can roll over while retaining existing history', async () => {
  const h = await completedHarness();
  delete h.session.mix.round;
  const older = { version: 1, phase: 'done', notes: [{ note: 'older private note' }], finalization: { txHash: hash(50) } };
  h.session.mixHistory = [older];
  h.balance = 10n;
  await h.tick();
  assert.equal(h.session.mix.round, 3);
  assert.equal(h.session.mixHistory.length, 2);
  assert.equal(h.session.mixHistory[0], older);
  assert.equal(h.saved.mixHistory[0].notes[0].note, 'older private note');
  assert.equal(h.prepared, 1);
  assert.equal(h.finalizes, 1);
});

test('a failed completed-balance probe cannot overwrite the archived source snapshot or reserve', async () => {
  const h = await completedHarness();
  const completed = h.session.mix;
  h.adapter.balance = async (s) => {
    s.mix.sourceBalanceWei = '999';
    s.mix.nativeReserveWei = '42';
    throw new Error('RPC balance failed');
  };
  await assert.rejects(h.tick(), /RPC balance failed/);
  assert.equal(h.session.mix, completed);
  assert.equal(Object.hasOwn(completed, 'sourceBalanceWei'), false);
  assert.equal(Object.hasOwn(completed, 'nativeReserveWei'), false);
  assert.equal(h.session.mixHistory, undefined);
  assert.equal(h.prepared, 1);
  assert.equal(h.deposits, 1);
  assert.equal(h.finalizes, 1);
});
