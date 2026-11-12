/* global module */
'use strict';

// Only the adapter touches RPCs, signing, proofs or relayers. This journal decides
// when those operations may run, and remains JSON-serializable for recovery.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TornadoFlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_NOTES = 100;
  const runtimes = new WeakMap();
  const HASH = /^0x[0-9a-f]{64}$/i;
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const STATUSES = new Set(['prepared', 'deposit_pending', 'deposited', 'withdraw_pending', 'withdrawn']);

  class FlowError extends Error {
    constructor(code) {
      super(code);
      this.name = 'TornadoFlowError';
      this.code = code;
    }
  }

  function requireThat(condition, code) {
    if (!condition) throw new FlowError(code);
  }

  function wei(value) {
    requireThat(typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value)), 'mixInvalidAmount');
    const n = BigInt(value);
    requireThat(n >= 0n, 'mixInvalidAmount');
    return n;
  }

  function sameAddress(a, b) {
    return typeof a === 'string' && typeof b === 'string' &&
      ADDRESS.test(a) && ADDRESS.test(b) && a.toLowerCase() === b.toLowerCase();
  }

  function planBalance(balance, pools, maxNotes = MAX_NOTES) {
    const available = wei(balance);
    requireThat(Array.isArray(pools) && pools.length > 0, 'mixUnsupportedAsset');
    requireThat(Number.isInteger(maxNotes) && maxNotes > 0 && maxNotes <= MAX_NOTES, 'mixInvalidLimit');
    const sorted = pools.map((pool) => {
      requireThat(pool && ADDRESS.test(pool.address), 'mixInvalidPool');
      const amount = wei(pool.amount);
      requireThat(amount > 0n, 'mixInvalidPool');
      return { pool: { ...pool, amount: amount.toString() }, amount };
    }).sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0);
    const plan = [];
    let remaining = available;
    for (const { pool, amount } of sorted) {
      while (remaining >= amount && plan.length < maxNotes) {
        plan.push({ ...pool });
        remaining -= amount;
      }
    }
    return {
      plan,
      snapshotWei: available.toString(),
      plannedWei: (available - remaining).toString(),
      remainingWei: remaining.toString(),
      limitReached: plan.length === maxNotes && remaining >= sorted[sorted.length - 1].amount,
    };
  }

  function updateCounts(mix) {
    const counts = { total: mix.plan ? mix.plan.length : 0, prepared: 0, depositPending: 0,
      deposited: 0, withdrawPending: 0, withdrawn: 0 };
    const keys = { prepared: 'prepared', deposit_pending: 'depositPending', deposited: 'deposited',
      withdraw_pending: 'withdrawPending', withdrawn: 'withdrawn' };
    for (const note of mix.notes) {
      requireThat(STATUSES.has(note.status), 'mixInvalidJournal');
      counts[keys[note.status]]++;
    }
    mix.counts = counts;
    return counts;
  }

  function summary(session) {
    const mix = session.mix;
    if (!mix) return { phase: 'waiting', remainingWei: '0', counts: { total: 0, withdrawn: 0 } };
    updateCounts(mix);
    return {
      phase: mix.phase,
      snapshotWei: mix.snapshotWei,
      plannedWei: mix.plannedWei || '0',
      remainingWei: mix.remainingWei || '0',
      expectedReceivedWei: mix.expectedReceivedWei || '0',
      counts: { ...mix.counts },
      limitReached: !!mix.limitReached,
      error: mix.error || null,
    };
  }

  async function save(session, adapter) {
    updateCounts(session.mix);
    await adapter.save(session);
  }

  function checkWithdrawal(note, result, session) {
    requireThat(result && result.status === 'confirmed', 'mixWithdrawalUnconfirmed');
    requireThat(sameAddress(result.recipient, session.secondWallet.address), 'mixWrongRecipient');
    requireThat(HASH.test(result.txHash), 'mixInvalidReceipt');
    const amount = wei(result.amount);
    requireThat(amount > 0n && amount <= wei(note.amount), 'mixInvalidReceivedAmount');
    return { ...result, amount: amount.toString() };
  }

  function checkDeposit(result) {
    requireThat(result && result.status === 'confirmed' && HASH.test(result.txHash), 'mixInvalidReceipt');
    return { ...result };
  }

  // A successful isSpent() call alone is deliberately insufficient: the adapter
  // must return the verified Withdrawal log, recipient, net amount and receipt.
  function applyReconciliation(note, result, session) {
    requireThat(result && typeof result === 'object', 'mixInvalidReconciliation');
    if (result.withdrawal && result.withdrawal.status === 'confirmed') {
      note.withdrawal = { ...note.withdrawal, ...checkWithdrawal(note, result.withdrawal, session) };
      note.status = 'withdrawn';
      return;
    }
    if (note.status === 'withdraw_pending' || note.status === 'withdrawn') {
      const withdrawal = result.withdrawal;
      if (withdrawal) note.withdrawal = { ...note.withdrawal, ...withdrawal };
      note.status = withdrawal && ['failed', 'absent'].includes(withdrawal.status) ? 'deposited' : 'withdraw_pending';
      return;
    }
    if (result.deposit && result.deposit.status === 'confirmed') {
      note.deposit = { ...note.deposit, ...checkDeposit(result.deposit) };
      note.status = 'deposited';
    } else {
      const deposit = result.deposit;
      if (deposit) note.deposit = { ...note.deposit, ...deposit };
      note.status = deposit && ['failed', 'absent'].includes(deposit.status) ? 'prepared' : 'deposit_pending';
    }
  }

  async function finishResult(session, result, adapter) {
    const mix = session.mix;
    requireThat(result && ['pending', 'confirmed', 'failed', 'absent'].includes(result.status), 'mixInvalidFinalization');
    if (result.status === 'confirmed') {
      requireThat(sameAddress(result.recipient, session.dest), 'mixWrongRecipient');
      requireThat(HASH.test(result.txHash) && wei(result.amount) > 0n, 'mixInvalidReceipt');
      mix.finalization = { ...mix.finalization, ...result, amount: wei(result.amount).toString() };
      mix.phase = 'done';
      mix.completedAt = Date.now();
      session.phase = 'done';
      delete mix.error;
    } else {
      mix.finalization = { ...mix.finalization, ...result };
      // Only a chain-confirmed failure, or the adapter's proof that there is no
      // broadcast intent, permits a fresh attempt on a later tick.
      mix.phase = ['failed', 'absent'].includes(result.status) ? 'collecting' : 'finalizing';
      if (result.error) mix.error = String(result.error);
    }
    await save(session, adapter);
  }

  async function rolloverCompleted(session, adapter) {
    const completed = session.mix;
    const history = session.mixHistory;
    requireThat(history === undefined || Array.isArray(history), 'mixInvalidJournal');
    const round = completed.round ?? ((history ? history.length : 0) + 1);
    requireThat(Number.isSafeInteger(round) && round > 0 && round < Number.MAX_SAFE_INTEGER, 'mixInvalidJournal');
    const pools = await adapter.pools(session);
    // The real adapter writes these live balance fields. A completed journal
    // must keep its original fee reserve and source snapshot intact, even when
    // a balance lookup fails, or while waiting for a later eligible deposit.
    const balanceKeys = ['sourceBalanceWei', 'nativeReserveWei'];
    const oldBalanceFields = balanceKeys.map((key) => ({ key,
      present: Object.prototype.hasOwnProperty.call(completed, key), value: completed[key] }));
    let available;
    try {
      available = await adapter.balance(session);
    } finally {
      for (const { key, present, value } of oldBalanceFields) {
        if (present) completed[key] = value;
        else delete completed[key];
      }
    }
    if (planBalance(available, pools).plan.length === 0) return summary(session);

    const previousPhase = session.phase;
    session.mixHistory = [...(history || []), completed];
    session.mix = { version: 1, round: round + 1, phase: 'waiting', notes: [], plan: [],
      remainingWei: '0', expectedReceivedWei: '0' };
    session.phase = 'waiting';
    try {
      // Persist the complete old journal and the new round together. No note is
      // generated and no transaction is signed in this handoff tick.
      await save(session, adapter);
    } catch (error) {
      session.mix = completed;
      session.phase = previousPhase;
      if (history === undefined) delete session.mixHistory;
      else session.mixHistory = history;
      throw error;
    }
    return summary(session);
  }

  async function run(session, adapter, runtime) {
    requireThat(session && sameAddress(session.secondWallet && session.secondWallet.address,
      session.secondWallet && session.secondWallet.address), 'mixMissingSecondWallet');
    requireThat(ADDRESS.test(session.dest) && !sameAddress(session.dest, session.secondWallet.address), 'mixInvalidDestination');
    if (!session.mix) {
      session.mix = { version: 1, round: 1, phase: 'waiting', notes: [], plan: [], remainingWei: '0', expectedReceivedWei: '0' };
      await save(session, adapter);
    }
    const mix = session.mix;
    requireThat(mix.version === 1 && Array.isArray(mix.notes) && Array.isArray(mix.plan) &&
      mix.plan.length <= MAX_NOTES && mix.notes.length <= mix.plan.length, 'mixInvalidJournal');
    if (runtime.mix !== mix) {
      runtime.mix = mix;
      runtime.verified = new Set();
    }
    if (mix.phase === 'done') return rolloverCompleted(session, adapter);
    if (mix.phase === 'finalizing') {
      await finishResult(session, await adapter.reconcileFinalization(session), adapter);
      return summary(session);
    }

    if (mix.snapshotWei === undefined) {
      const pools = await adapter.pools(session);
      const plan = planBalance(await adapter.balance(session), pools);
      if (plan.plan.length === 0) {
        mix.phase = 'waiting';
        mix.remainingWei = plan.remainingWei;
        await save(session, adapter);
        return summary(session);
      }
      Object.assign(mix, plan, { phase: 'preparing', createdAt: Date.now() });
      // Freeze the entire plan before generating notes or making any deposit.
      await save(session, adapter);
    }

    while (mix.notes.length < mix.plan.length) {
      const index = mix.notes.length;
      const pool = mix.plan[index];
      const secret = await adapter.prepareNote(pool, session);
      requireThat(secret && typeof secret.note === 'string' && secret.note.length > 0 &&
        HASH.test(secret.commitment) && HASH.test(secret.nullifierHash), 'mixInvalidNote');
      requireThat(!mix.notes.some((n) => n.commitment.toLowerCase() === secret.commitment.toLowerCase() ||
        n.nullifierHash.toLowerCase() === secret.nullifierHash.toLowerCase()), 'mixDuplicateNote');
      mix.notes.push({ ...secret, id: `${mix.round || 1}:${mix.createdAt}:${index}`, pool: { ...pool },
        amount: pool.amount, status: 'prepared' });
      // The note is durable before its address/commitment can reach a contract.
      await save(session, adapter);
    }

    // On a fresh page, verify cached non-pending states against canonical chain
    // receipts. A pending transaction is always reconciled instead of resent.
    for (const note of mix.notes) {
      if (note.status !== 'prepared' && (note.status.endsWith('_pending') || !runtime.verified.has(note.id))) {
        const previous = note.status;
        applyReconciliation(note, await adapter.reconcile(note, session), session);
        runtime.verified.add(note.id);
        await save(session, adapter);
        if (previous.endsWith('_pending') || note.status.endsWith('_pending') || note.status === 'prepared') return summary(session);
      }
    }

    const prepared = mix.notes.find((n) => n.status === 'prepared');
    if (prepared) {
      mix.phase = 'depositing';
      prepared.status = 'deposit_pending';
      // Persist intent before calling any method that may sign/broadcast.
      await save(session, adapter);
      const result = await adapter.deposit(prepared, session);
      requireThat(result && ['pending', 'confirmed', 'failed', 'absent'].includes(result.status), 'mixInvalidDeposit');
      if (result.status === 'confirmed') {
        prepared.deposit = { ...prepared.deposit, ...checkDeposit(result) };
        prepared.status = 'deposited';
        runtime.verified.add(prepared.id);
      } else {
        prepared.deposit = { ...prepared.deposit, ...result };
        if (['failed', 'absent'].includes(result.status)) prepared.status = 'prepared';
      }
      await save(session, adapter);
      return summary(session);
    }

    const deposited = mix.notes.find((n) => n.status === 'deposited');
    if (deposited) {
      mix.phase = 'withdrawing';
      deposited.status = 'withdraw_pending';
      await save(session, adapter);
      const result = await adapter.withdraw(deposited, session);
      requireThat(result && ['pending', 'confirmed', 'failed', 'absent'].includes(result.status), 'mixInvalidWithdrawal');
      if (result.status === 'confirmed') {
        deposited.withdrawal = { ...deposited.withdrawal, ...checkWithdrawal(deposited, result, session) };
        deposited.status = 'withdrawn';
      } else {
        deposited.withdrawal = { ...deposited.withdrawal, ...result };
        if (['failed', 'absent'].includes(result.status)) deposited.status = 'deposited';
      }
      await save(session, adapter);
      return summary(session);
    }

    requireThat(mix.notes.length > 0 && mix.notes.every((n) => n.status === 'withdrawn'), 'mixBatchIncomplete');
    mix.phase = 'collecting';
    await save(session, adapter);
    // Re-check every withdrawal before sweeping, including notes restored from
    // disk. A later reorg, wrong recipient or ambiguous isSpent leaves B untouched.
    let expected = 0n;
    for (const note of mix.notes) {
      applyReconciliation(note, await adapter.reconcile(note, session), session);
      await save(session, adapter);
      if (note.status !== 'withdrawn') return summary(session);
      expected += wei(note.withdrawal.amount);
    }
    mix.expectedReceivedWei = expected.toString();
    if (wei(await adapter.secondBalance(session)) < expected) {
      await save(session, adapter);
      return summary(session);
    }
    mix.phase = 'finalizing';
    mix.finalization = { ...mix.finalization, status: 'intent', recipient: session.dest };
    await save(session, adapter);
    await finishResult(session, await adapter.finalize(session), adapter);
    return summary(session);
  }

  async function tick(session, adapter) {
    requireThat(session && typeof session === 'object', 'mixInvalidSession');
    let runtime = runtimes.get(session);
    if (!runtime) {
      runtime = { busy: false, mix: null, verified: new Set() };
      runtimes.set(session, runtime);
    }
    if (runtime.busy) return summary(session);
    runtime.busy = true;
    try {
      // An error from an earlier RPC/prover attempt is replaced by the current
      // tick's result. A new failure below restores a visible, persisted error.
      if (session.mix) delete session.mix.error;
      return await run(session, adapter, runtime);
    } catch (e) {
      if (session.mix) {
        session.mix.error = String(e.code || e.message || e);
        // Never continue to a transfer after a journal write failed.
        try { await save(session, adapter); } catch { /* preserve the original error */ }
      }
      throw e;
    } finally {
      runtime.busy = false;
    }
  }

  return { tick, planBalance, summary, FlowError, MAX_NOTES };
});
