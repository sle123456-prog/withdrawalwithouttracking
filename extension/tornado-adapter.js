/* global module */
'use strict';
(function (root) {
  const POOL_ABI = [
    'function denomination() view returns (uint256)',
    'function token() view returns (address)',
    'function nextIndex() view returns (uint32)',
    'function isKnownRoot(bytes32) view returns (bool)',
    'function isSpent(bytes32) view returns (bool)',
    'function deposit(bytes32) payable',
    'event Deposit(bytes32 indexed commitment,uint32 leafIndex,uint256 timestamp)',
    'event Withdrawal(address to,bytes32 nullifierHash,address indexed relayer,uint256 fee)',
  ];
  const TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256)',
    'function transfer(address,uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ];
  const HASH = /^0x[0-9a-f]{64}$/i;
  const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  function create(config) {
    const E = root.ethers;
    const { session: s, provider: p, mainnetProvider, storage, gasWallet, chain } = config;
    const confirmations = config.confirmations ?? 12;
    if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error('mixInvalidConfirmations');
    const poolInterface = new E.Interface(POOL_ABI);
    const tokenInterface = new E.Interface(TOKEN_ABI);
    const first = new E.Wallet(s.privateKey, p);
    const second = new E.Wallet(s.secondWallet.privateKey, p);
    if (!equal(first.address, s.address) || !equal(second.address, s.secondWallet.address) ||
        equal(first.address, second.address) || equal(second.address, s.dest)) throw new Error('mixInvalidWallet');
    const save = async () => config.save(s);
    const progress = (key) => { if (config.onProgress) config.onProgress(key); };
    const native = s.asset === 'native';
    const pool = (n) => new E.Contract(n.pool.address, POOL_ABI, p);
    const token = () => new E.Contract(s.asset, TOKEN_ABI, p);
    const price = async () => BigInt(config.getGasPrice ? await config.getGasPrice(p) : (await p.getFeeData()).gasPrice);
    const extraL1 = async (tx) => config.l1Fee ? BigInt(await config.l1Fee(p, chain, tx)) : 0n;
    const originalPool = (n) => ({ ...n.pool, amount: n.pool.denomination });

    async function confirmedBlock() {
      return Math.max(0, (await p.getBlockNumber()) - confirmations + 1);
    }

    async function receipt(hash) {
      if (!HASH.test(hash || '')) return null;
      const rc = await p.getTransactionReceipt(hash);
      if (!rc || rc.blockNumber > await confirmedBlock()) return null;
      const block = await p.getBlock(rc.blockNumber);
      if (!block || !equal(block.hash, rc.blockHash)) return null;
      if (!equal(rc.hash || rc.transactionHash, hash)) throw new Error('mixInvalidReceipt');
      return rc;
    }

    function events(rc, address, name, iface = poolInterface) {
      const found = [];
      for (const log of rc.logs) {
        if (!equal(log.address, address)) continue;
        try {
          const event = iface.parseLog(log);
          if (event && event.name === name) found.push(event.args);
        } catch { /* Other logs from the same contract are not this event. */ }
      }
      return found;
    }

    function verifyTransfer(rc, from, to, amount) {
      const matches = events(rc, s.asset, 'Transfer', tokenInterface).filter((x) =>
        equal(x.from, from) && equal(x.to, to));
      const received = matches.reduce((total, x) => total + BigInt(x.value), 0n);
      if (received !== amount) throw new Error('mixTokenTransferMismatch');
    }

    async function announce(operation, key) {
      if (operation.logged || !config.onTx) return;
      await config.onTx(operation.hash, key);
      operation.logged = true;
      await save();
    }

    // Every chain write is a locally signed raw transaction journaled before
    // broadcast. Recovery may rebroadcast that exact raw transaction only.
    async function transact(owner, key, wallet, build, label, allowNew = true, validate) {
      owner.operations ||= {};
      const attempts = owner.operations[key] ||= [];
      let operation = attempts[attempts.length - 1];
      if (operation && operation.status === 'failed') throw new Error('mixTransactionReverted');
      if (!operation) {
        if (!allowNew) return { status: 'absent' };
        const request = await build();
        const nonce = await p.getTransactionCount(wallet.address, 'pending');
        const tx = { ...request, type: 0, chainId: s.chainId, nonce };
        const raw = await wallet.signTransaction(tx);
        operation = { raw, hash: E.keccak256(raw), nonce, from: wallet.address,
          to: tx.to, value: String(tx.value || 0n), data: tx.data || '0x',
          gasLimit: String(tx.gasLimit), gasPrice: String(tx.gasPrice), status: 'signed', createdAt: Date.now() };
        attempts.push(operation);
        await save();
      }
      if (!HASH.test(operation.hash || '') || !operation.raw ||
          E.keccak256(operation.raw) !== operation.hash || !equal(operation.from, wallet.address)) throw new Error('mixInvalidTransactionJournal');
      const rc = await receipt(operation.hash);
      if (rc) {
        if (!equal(rc.from, operation.from) || !equal(rc.to, operation.to)) throw new Error('mixInvalidReceipt');
        operation.blockNumber = rc.blockNumber;
        operation.blockHash = rc.blockHash;
        if (Number(rc.status) !== 1) {
          operation.status = 'failed';
          await save();
          // A canonical revert has already charged gas. Retrying with a fresh
          // nonce could charge the user indefinitely (full/frozen/rejecting
          // contracts), so only manual recovery may replace this operation.
          throw new Error('mixTransactionReverted');
        }
        if (validate) await validate(rc, operation);
        operation.status = 'confirmed';
        await save();
        await announce(operation, label);
        return { status: 'confirmed', txHash: operation.hash, blockNumber: rc.blockNumber, receipt: rc, operation };
      }
      // A formerly confirmed receipt disappeared: keep the original intent and
      // wait for canonical confirmation instead of spending the same funds again.
      operation.status = 'pending';
      if (!operation.lastBroadcastAt || Date.now() - operation.lastBroadcastAt > 30000) {
        operation.lastBroadcastAt = Date.now();
        await save();
        try { await p.broadcastTransaction(operation.raw); }
        catch (e) {
          // RPC timeouts and "already known" do not establish that broadcast
          // failed. Keep the same hash recoverable and expose actionable errors.
          const message = String(e.shortMessage || e.message || e);
          if (!/already known|known transaction|nonce too low|timeout|timed out|network|server/i.test(message)) {
            operation.lastError = message.slice(0, 180);
            await save();
            throw e;
          }
        }
      }
      return { status: 'pending', txHash: operation.hash };
    }

    async function gasEstimate(request, fallback) {
      try { return (BigInt(await p.estimateGas(request)) * 130n + 99n) / 100n; }
      catch { return fallback; }
    }

    async function gasCost(request, gasLimit, gasPrice) {
      return gasLimit * gasPrice + await extraL1({ ...request, gasLimit, gasPrice });
    }

    async function ensureFirstGas(note, needed) {
      note.funding ||= [];
      const last = note.funding[note.funding.length - 1];
      if (last) {
        const attempts = last.operations && last.operations.funding;
        const op = attempts && attempts[attempts.length - 1];
        if (op && op.status === 'failed') throw new Error('mixTransactionReverted');
        if (op && op.status !== 'confirmed' && op.status !== 'failed') {
          // This transaction is already signed. Replacing/removing the Gas
          // wallet must not prevent receipt checks or replay of the same bytes.
          const wallet = { address: op.from };
          const r = await transact(last, 'funding', wallet, null, 'mixTxGas', false);
          if (r.status !== 'confirmed') return false;
        }
      }
      const balance = await p.getBalance(first.address);
      if (balance >= needed) return true;
      if (!gasWallet) throw new Error(native ? 'mixSourceGasLow' : 'mixNeedGasWallet');
      const wallet = new E.Wallet(gasWallet.privateKey, p);
      if (equal(wallet.address, second.address)) throw new Error('mixInvalidGasWallet');
      const amount = (needed - balance) * 130n / 100n + 1n;
      const gasPrice = await price();
      const request = { from: wallet.address, to: first.address, value: amount };
      const gasLimit = await gasEstimate(request, 30000n);
      if (await p.getBalance(wallet.address) < amount + await gasCost(request, gasLimit, gasPrice)) throw new Error('mixGasWalletLow');
      const funding = {};
      note.funding.push(funding);
      await save();
      progress('mixFundingGas');
      const result = await transact(funding, 'funding', wallet, async () =>
        ({ to: first.address, value: amount, gasLimit, gasPrice }), 'mixTxGas');
      return result.status === 'confirmed';
    }

    async function pools() {
      const list = root.TornadoPools.getPools(s.chainId, s.asset);
      return list.map((entry) => ({ ...entry, denomination: entry.amount,
        amount: E.parseUnits(entry.amount, entry.decimals).toString() }));
    }

    async function balance() {
      const blockTag = await confirmedBlock();
      if (!native) return token().balanceOf(first.address, { blockTag });
      const available = await p.getBalance(first.address, blockTag);
      const list = await pools();
      if (!list.length) throw new Error('mixUnsupportedAsset');
      // Deposit is expensive. Over-reservation only leaves more ETH in wallet 1;
      // it never routes any remainder around Tornado or into wallet 2.
      const gasPrice = await price();
      const perDeposit = 1400000n * gasPrice + await extraL1({ to: list[0].address,
        value: BigInt(list[0].amount), data: poolInterface.encodeFunctionData('deposit', ['0x' + 'ff'.repeat(32)]),
        gasLimit: 1400000n, gasPrice });
      // Subtracting gas can change ONE large note into many smaller notes. Try
      // each possible note budget so the final greedy plan always fits its own
      // gas reserve, including exact-denomination deposits at elevated fees.
      let best = null;
      for (let budget = 0; budget <= 100; budget++) {
        const reserve = perDeposit * BigInt(budget);
        const usable = available > reserve ? available - reserve : 0n;
        let remaining = usable;
        let count = 0;
        for (const entry of list) {
          const amount = BigInt(entry.amount);
          while (remaining >= amount && count < 100) { remaining -= amount; count++; }
        }
        const planned = usable - remaining;
        if (count <= budget && (!best || planned > best.planned)) best = { reserve, usable, planned };
      }
      const reserve = best ? best.reserve : available;
      s.mix.sourceBalanceWei = available.toString();
      s.mix.nativeReserveWei = reserve.toString();
      return best ? best.usable : 0n;
    }

    async function refundNeeded() {
      if (native) return 0n;
      const gasPrice = await price();
      const request = { from: second.address, to: s.asset,
        data: tokenInterface.encodeFunctionData('transfer', [s.dest, 1n]) };
      const gasLimit = await gasEstimate(request, 130000n);
      const needed = await gasCost(request, gasLimit, gasPrice);
      const existing = await p.getBalance(second.address, await confirmedBlock());
      return existing >= needed ? 0n : (needed - existing) * 130n / 100n + 1n;
    }

    async function selectRelayer(note) {
      const selected = await root.TornadoRelayer.select({ pool: originalPool(note), provider: p,
        mainnetProvider, storage, customUrl: s.relayerUrl || s.mixRelayer || s.relayer || '' });
      const refund = await refundNeeded();
      const quote = await root.TornadoRelayer.quote({ pool: originalPool(note), provider: p, relayer: selected,
        refund: refund.toString() });
      if (BigInt(quote.fee) >= BigInt(note.amount) || BigInt(quote.fee) < 0n || BigInt(quote.refund) !== refund) throw new Error('mixRelayerFeeTooHigh');
      return { relayer: selected, quote: { fee: String(quote.fee), refund: String(quote.refund) } };
    }

    async function prepareNote(entry) {
      progress('mixPreparing');
      await root.TornadoCrypto.ready();
      const code = await p.getCode(entry.address);
      if (code === '0x') throw new Error('mixPoolUnavailable');
      const contract = new E.Contract(entry.address, POOL_ABI, p);
      if (BigInt(await contract.denomination()) !== BigInt(entry.amount)) throw new Error('mixPoolMismatch');
      if (Number(await contract.nextIndex()) >= 2 ** 20) throw new Error('mixPoolFull');
      if (!native && !equal(await contract.token(), s.asset)) throw new Error('mixPoolMismatch');
      const provisional = { pool: entry, amount: entry.amount };
      // Establish a compatible relayer and affordable quote before the first
      // deposit. Funds never enter a pool merely because a web URL was supplied.
      const { relayer, quote } = await selectRelayer(provisional);
      const note = await root.TornadoCrypto.createNote({ currency: entry.currency,
        amount: entry.denomination, chainId: s.chainId });
      return { ...note, relayer, quote };
    }

    async function advanceDeposit(note, allowNew = false) {
      // Ancillary approvals and funding consume gas too. Any confirmed revert
      // in this pipeline pauses it before another operation can be prepared.
      for (const owner of [note, ...(note.funding || [])]) {
        for (const attempts of Object.values(owner.operations || {})) {
          if (attempts.some((operation) => operation.status === 'failed')) throw new Error('mixTransactionReverted');
        }
      }
      const existing = note.operations && note.operations.deposit;
      const op = existing && existing[existing.length - 1];
      if (op) {
        const result = await transact(note, 'deposit', first, null, 'mixTxDeposit', false,
          (rc) => validateDeposit(note, rc));
        return publicResult(result);
      }
      if (Number(await pool(note).nextIndex()) >= 2 ** 20) throw new Error('mixPoolFull');
      const amount = BigInt(note.amount);
      const gasPrice = await price();
      if (!native) {
        for (const key of ['resetApproval', 'approval']) {
          const attempts = note.operations && note.operations[key];
          const pending = attempts && attempts[attempts.length - 1];
          if (pending && pending.status !== 'confirmed' && pending.status !== 'failed') {
            const result = await transact(note, key, first, null, 'mixTxApprove', false);
            if (result.status !== 'confirmed') return { status: 'pending' };
          }
        }
        const allowance = BigInt(await token().allowance(first.address, note.pool.address));
        if (allowance < amount) {
          const reset = allowance > 0n;
          const data = tokenInterface.encodeFunctionData('approve', [note.pool.address, reset ? 0n : amount]);
          const request = { from: first.address, to: s.asset, data };
          const gasLimit = await gasEstimate(request, 130000n);
          const needed = await gasCost(request, gasLimit, gasPrice) + 1400000n * gasPrice;
          if (!await ensureFirstGas(note, needed)) return { status: 'pending' };
          const result = await transact(note, reset ? 'resetApproval' : 'approval', first, async () =>
            ({ to: s.asset, data, gasLimit, gasPrice }), 'mixTxApprove');
          // A new approval needs its own confirmation before any deposit.
          return { status: 'pending', approval: result.status };
        }
      }
      const data = poolInterface.encodeFunctionData('deposit', [note.commitment]);
      const value = native ? amount : 0n;
      const request = { from: first.address, to: note.pool.address, value, data };
      if (!await ensureFirstGas(note, value + await gasCost(request, 1400000n, gasPrice))) return { status: 'pending' };
      const gasLimit = await gasEstimate(request, 1400000n);
      if (await p.getBalance(first.address) < value + await gasCost(request, gasLimit, gasPrice)) throw new Error('mixSourceGasLow');
      progress('mixDepositing');
      const result = await transact(note, 'deposit', first, async () =>
        ({ to: note.pool.address, value, data, gasLimit, gasPrice }), 'mixTxDeposit', allowNew,
        (rc) => validateDeposit(note, rc));
      return publicResult(result);
    }

    function validateDeposit(note, rc) {
      const matches = events(rc, note.pool.address, 'Deposit').filter((event) => equal(event.commitment, note.commitment));
      if (matches.length !== 1) throw new Error('mixDepositEventMissing');
      if (!native) verifyTransfer(rc, first.address, note.pool.address, BigInt(note.amount));
      note.leafIndex = Number(matches[0].leafIndex);
      note.depositBlock = rc.blockNumber;
      note.depositHash = rc.hash || rc.transactionHash;
    }

    function publicResult(result) {
      const { receipt: ignored, operation: ignoredOperation, ...rest } = result;
      return rest;
    }

    async function logsInRanges(filter, fromBlock, toBlock, onChunk) {
      let cursor = fromBlock;
      let size = 20000;
      while (cursor <= toBlock) {
        const end = Math.min(cursor + size - 1, toBlock);
        let logs;
        try { logs = await p.getLogs({ ...filter, fromBlock: cursor, toBlock: end }); }
        catch (e) { if (size <= 1) throw e; size = Math.max(1, Math.floor(size / 2)); continue; }
        await onChunk(logs, end);
        cursor = end + 1;
        if (size < 20000) size = Math.min(20000, size * 2);
      }
    }

    async function depositLeaves(note) {
      progress('mixSyncing');
      const key = `tornado:leaves:v1:${s.chainId}:${note.pool.address.toLowerCase()}`;
      let cache = await storage.get(key);
      if (cache && (cache.version !== 1 || !Array.isArray(cache.leaves) ||
          cache.leaves.some((x) => !HASH.test(x)) || !equal((await p.getBlock(cache.toBlock))?.hash, cache.blockHash))) cache = null;
      if (!cache) cache = { version: 1, toBlock: note.pool.deployedBlock - 1, leaves: [], blockHash: null };
      const end = await confirmedBlock();
      if (cache.toBlock > end) throw new Error('mixChainBehind');
      const topic = poolInterface.getEvent('Deposit').topicHash;
      await logsInRanges({ address: note.pool.address, topics: [topic] }, cache.toBlock + 1, end, async (logs, lastBlock) => {
        logs.sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? a.logIndex) - (b.index ?? b.logIndex));
        const startLength = cache.leaves.length;
        for (const log of logs) {
          if (log.removed) throw new Error('mixChainReorg');
          const args = poolInterface.parseLog(log).args;
          const index = Number(args.leafIndex);
          if (index !== cache.leaves.length) throw new Error('mixMissingDepositEvents');
          cache.leaves.push(args.commitment);
        }
        const block = await p.getBlock(lastBlock);
        if (!block) { cache.leaves.length = startLength; throw new Error('mixChainReorg'); }
        cache.toBlock = lastBlock;
        cache.blockHash = block.hash;
        await storage.set(key, cache);
      });
      const nextIndex = Number(await pool(note).nextIndex({ blockTag: end }));
      if (cache.leaves.length !== nextIndex || !equal(cache.leaves[note.leafIndex], note.commitment)) throw new Error('mixMissingDepositEvents');
      return cache.leaves;
    }

    async function withdrawalReceipt(note, hash) {
      const rc = await receipt(hash);
      if (!rc) return null;
      if (Number(rc.status) !== 1) return { status: 'failed', txHash: hash, error: 'mixTransactionReverted' };
      const matches = events(rc, note.pool.address, 'Withdrawal').filter((event) => equal(event.nullifierHash, note.nullifierHash));
      if (matches.length !== 1) throw new Error('mixWithdrawalEventMissing');
      const event = matches[0];
      if (!equal(event.to, second.address)) throw new Error('mixWrongRecipient');
      const fee = BigInt(event.fee);
      if (fee < 0n || fee >= BigInt(note.amount)) throw new Error('mixInvalidReceivedAmount');
      const intent = note.withdrawalIntent;
      const intents = [intent, ...(note.withdrawalAttempts || [])].filter(Boolean);
      if (intents.length && !intents.some((item) => equal(event.relayer, item.relayer.address) && fee === BigInt(item.fee))) throw new Error('mixWithdrawalParametersMismatch');
      const amount = BigInt(note.amount) - fee;
      if (!native) verifyTransfer(rc, note.pool.address, second.address, amount);
      else {
        const tx = await p.getTransaction(hash);
        // Tornado's native payout may be an internal call; the canonical event
        // and contract amount are checked together with confirmed wallet balance.
        if (!tx || !await pool(note).isSpent(note.nullifierHash, { blockTag: rc.blockNumber })) throw new Error('mixWithdrawalUnconfirmed');
      }
      if (!note.withdrawalLogged) {
        if (config.onTx) await config.onTx(hash, 'mixTxWithdraw');
        note.withdrawalLogged = true;
        await save();
      }
      return { status: 'confirmed', txHash: hash, recipient: event.to, amount: amount.toString(),
        blockNumber: rc.blockNumber, relayer: event.relayer, fee: fee.toString() };
    }

    async function findWithdrawal(note) {
      let found = null;
      const topic = poolInterface.getEvent('Withdrawal').topicHash;
      await logsInRanges({ address: note.pool.address, topics: [topic] },
        note.depositBlock ?? note.pool.deployedBlock, await confirmedBlock(), async (logs) => {
          for (const log of logs) {
            const args = poolInterface.parseLog(log).args;
            if (equal(args.nullifierHash, note.nullifierHash)) {
              const result = await withdrawalReceipt(note, log.transactionHash);
              if (result && result.status === 'confirmed') found = result;
            }
          }
        });
      return found;
    }

    async function submitIntent(note) {
      const intent = note.withdrawalIntent;
      intent.submittedAt = Date.now();
      await save();
      const result = await relayerRequest(() => root.TornadoRelayer.submit({ relayer: intent.relayer,
        proof: intent.proof, args: intent.args, contract: note.pool.address }));
      if (!result || !result.id) throw new Error('mixRelayerJobMissing');
      intent.id = result.id;
      if (HASH.test(result.txHash || '')) intent.txHash = result.txHash;
      await save();
    }

    async function relayerRequest(request) {
      try { return await request(); }
      catch (error) {
        const wrapped = new Error(String(error.message || error));
        wrapped.relayerUnavailable = true;
        throw wrapped;
      }
    }

    async function advanceWithdrawal(note, allowNew = false) {
      const contract = pool(note);
      const spent = await contract.isSpent(note.nullifierHash);
      let intent = note.withdrawalIntent;
      if (spent) {
        if (intent && intent.txHash) {
          const known = await withdrawalReceipt(note, intent.txHash);
          if (known) return known;
        }
        return await findWithdrawal(note) || { status: 'pending' };
      }
      if (intent && intent.txHash) {
        const known = await withdrawalReceipt(note, intent.txHash);
        if (known) {
          if (known.status === 'confirmed') return known;
          intent.status = 'failed';
          await save();
          if (!allowNew) return known;
        }
      }
      if (intent && intent.status !== 'failed') {
        const expired = !await contract.isKnownRoot(intent.args[0]);
        let failed = false;
        try {
          if (intent.id && !expired) {
            const job = await relayerRequest(() => root.TornadoRelayer.job({ url: intent.relayer.url, id: intent.id }));
            intent.networkFailures = 0;
            const hash = job.txHash || job.transactionHash;
            if (HASH.test(hash || '')) {
              intent.txHash = hash;
              await save();
              const known = await withdrawalReceipt(note, hash);
              if (known && known.status === 'confirmed') return known;
              if (known && known.status === 'failed') failed = true;
              else if (!expired) return { status: 'pending', txHash: hash };
            }
            failed ||= /failed|error/i.test(String(job.status)) && Date.now() - intent.submittedAt > 60000;
          } else if (!intent.id && (!intent.submittedAt || Date.now() - intent.submittedAt > 60000)) {
            if (!expired) await submitIntent(note);
          }
        } catch (e) {
          if (!e.relayerUnavailable) throw e;
          intent.networkFailures = (intent.networkFailures || 0) + 1;
          await save();
          if (intent.networkFailures < 3 || Date.now() - (intent.createdAt || intent.submittedAt) < 120000) throw e;
          failed = true;
        }
        if (!expired && !failed) return { status: 'pending', txHash: intent.txHash };
        // The old job may still arrive. Re-proving uses the SAME note/nullifier
        // and recipient, so the contract can pay only once. Keep every previous
        // public intent to verify a delayed receipt against its original fee.
        intent.status = 'failed';
        intent.failureReason = expired ? 'mixProofRootExpired' : 'mixRelayerJobFailed';
        await save();
      }
      if (!allowNew && note.status !== 'withdraw_pending') return { status: 'absent' };
      progress('mixPreparingWithdrawal');
      const { relayer, quote } = await selectRelayer(note);
      const leaves = await depositLeaves(note);
      progress('mixProving');
      const proof = await root.TornadoCrypto.prove({ note: note.note, leaves, recipient: second.address,
        relayer: relayer.address, fee: quote.fee, refund: quote.refund });
      const args = proof.args;
      if (!Array.isArray(args) || args.length !== 6 || !equal(args[1], note.nullifierHash) ||
          BigInt(args[2]) !== BigInt(second.address) || BigInt(args[3]) !== BigInt(relayer.address) ||
          BigInt(args[4]) !== BigInt(quote.fee) || BigInt(args[5]) !== BigInt(quote.refund)) throw new Error('mixProofParametersMismatch');
      if (!await contract.isKnownRoot(args[0]) || await contract.isSpent(note.nullifierHash)) throw new Error('mixProofRootExpired');
      intent = { relayer, fee: quote.fee, refund: quote.refund, proof: proof.proof, args,
        status: 'prepared', createdAt: Date.now() };
      if (note.withdrawalIntent) {
        note.withdrawalAttempts ||= [];
        note.withdrawalAttempts.push(note.withdrawalIntent);
      }
      note.withdrawalIntent = intent;
      await save();
      progress('mixWithdrawing');
      await submitIntent(note);
      return { status: 'pending', txHash: intent.txHash };
    }

    async function reconcile(note) {
      // Deposit helpers may resume a saved approval/funding/deposit pipeline;
      // each of those helpers journals raw transactions before its first send.
      if (note.status === 'deposit_pending' || note.status === 'deposited') {
        return { deposit: await advanceDeposit(note, false) };
      }
      if (note.status === 'withdraw_pending' || note.status === 'withdrawn') {
        return { withdrawal: await advanceWithdrawal(note, false) };
      }
      return { deposit: { status: 'absent' } };
    }

    async function secondBalance() {
      const blockTag = await confirmedBlock();
      return native ? p.getBalance(second.address, blockTag) : token().balanceOf(second.address, { blockTag });
    }

    async function finalize(allowNew = true) {
      const mix = s.mix;
      const current = mix.operations && mix.operations.finalization;
      const previous = current && current[current.length - 1];
      if (previous && previous.status === 'failed') throw new Error('mixTransactionReverted');
      if (!previous && !allowNew) return { status: 'absent' };
      const result = await transact(mix, 'finalization', second, async () => {
        const amount = BigInt(await secondBalance());
        if (amount < BigInt(mix.expectedReceivedWei) || amount <= 0n) throw new Error('mixCollecting');
        const gasPrice = await price();
        let request;
        if (native) {
          request = { from: second.address, to: s.dest, value: 1n };
          const code = await p.getCode(s.dest, await confirmedBlock());
          const gasLimit = code === '0x' ? 21000n : await gasEstimate(request, 30000n);
          const reserve = await gasCost({ ...request, value: amount }, gasLimit, gasPrice);
          if (amount <= reserve) throw new Error('mixSecondGasLow');
          return { to: s.dest, value: amount - reserve, gasLimit, gasPrice };
        }
        const data = tokenInterface.encodeFunctionData('transfer', [s.dest, amount]);
        request = { from: second.address, to: s.asset, data };
        const gasLimit = await gasEstimate(request, 130000n);
        if (await p.getBalance(second.address, await confirmedBlock()) < await gasCost(request, gasLimit, gasPrice)) throw new Error('mixSecondGasLow');
        return { to: s.asset, data, gasLimit, gasPrice };
      }, 'mixTxFinal', allowNew, async (rc, operation) => {
        if (!native) {
          const decoded = tokenInterface.decodeFunctionData('transfer', operation.data);
          if (!equal(decoded[0], s.dest)) throw new Error('mixWrongRecipient');
          verifyTransfer(rc, second.address, s.dest, BigInt(decoded[1]));
        }
      });
      if (result.status !== 'confirmed') return publicResult(result);
      const amount = native ? BigInt(result.operation.value) :
        BigInt(tokenInterface.decodeFunctionData('transfer', result.operation.data)[1]);
      return { status: 'confirmed', txHash: result.txHash, recipient: s.dest, amount: amount.toString() };
    }

    return {
      pools, balance, prepareNote, secondBalance,
      save,
      deposit: (note) => advanceDeposit(note, true),
      withdraw: (note) => advanceWithdrawal(note, true),
      reconcile,
      finalize: () => finalize(true),
      reconcileFinalization: () => finalize(false),
    };
  }

  const api = { create, POOL_ABI, TOKEN_ABI };
  root.TornadoAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis === 'undefined' ? window : globalThis);
