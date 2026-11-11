/* Tornado Cash Classic relayer client. Public proof inputs only; deposit notes stay local.
 * Protocol references: tornadocash/tornado-classic-ui store/relayer.js,
 * services/registry/index.js, services/schema/relayer and abis/Aggregator.abi.json.
 */
(function (root) {
  'use strict';

  function create(deps = {}) {
    const E = deps.ethers || root.ethers;
    const P = deps.pools || root.TornadoPools;
    const fetcher = deps.fetch || ((...args) => root.fetch(...args));
    const timeoutMs = deps.timeoutMs || 20000;
    const CACHE_VERSION = 1;
    const CONFIRMATIONS = 12;
    const REGISTRY_ABI = [
      'event RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount)',
      'function minStakeAmount() view returns (uint256)',
    ];
    const AGGREGATOR_ABI = [
      'function relayersData(bytes32[] _relayers, string[] _subdomains) view returns ((address owner, uint256 balance, bool isRegistered, string[20] records)[])',
    ];

    function requirements() {
      if (!E || !P) throw new Error('Tornado relayer dependencies are not loaded');
    }

    function urlBase(value) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid relayer URL');
      let url;
      try { url = new URL(value.trim()); } catch { throw new Error('Invalid relayer URL'); }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error('Relayer URL must use HTTPS (HTTP is allowed only on localhost)');
      }
      if (url.username || url.password || url.search || url.hash) throw new Error('Relayer URL must not contain credentials, a query, or a fragment');
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.href;
    }

    function address(value) {
      if (typeof value !== 'string' || !E.isAddress(value)) throw new Error('Invalid relayer address');
      const result = E.getAddress(value);
      if (result === E.ZeroAddress) throw new Error('Invalid relayer address');
      return result;
    }

    function uint(value) {
      if (typeof value !== 'string' && typeof value !== 'bigint') throw new Error('Invalid integer amount');
      if (typeof value === 'string' && !/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) throw new Error('Invalid integer amount');
      const result = BigInt(value);
      if (result < 0n || result >= (1n << 256n)) throw new Error('Invalid integer amount');
      return result;
    }

    function poolInfo(pool) {
      requirements();
      if (!pool || !Number.isSafeInteger(Number(pool.chainId))) throw new Error('Invalid Tornado pool');
      const chainId = Number(pool.chainId);
      const network = P.networks[chainId];
      const token = network && network.tokens[pool.currency];
      const amount = String(pool.amount);
      if (!token || !token.instances[amount] || Number(pool.decimals) !== token.decimals ||
          address(pool.address) !== address(token.instances[amount])) throw new Error('Unsupported Tornado pool');
      const value = E.parseUnits(amount, token.decimals);
      if (value <= 0n || (pool.value !== undefined && uint(pool.value) !== value)) throw new Error('Invalid pool denomination');
      return { chainId, network, token, currency: pool.currency, amount, address: address(pool.address), value, decimals: token.decimals,
        native: pool.currency === network.currency };
    }

    async function verifyNetwork(provider, chainId) {
      if (!provider || !provider.getNetwork) throw new Error('Missing RPC provider');
      const network = await provider.getNetwork();
      if (BigInt(network.chainId) !== BigInt(chainId)) throw new Error('Relayer RPC chain does not match the selected pool');
    }

    async function json(url, options = {}) {
      const aborter = new AbortController();
      const timer = setTimeout(() => aborter.abort(), timeoutMs);
      try {
        const response = await fetcher(url, {
          method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
          redirect: 'error', cache: 'no-store', ...options, signal: aborter.signal,
        });
        if (!response || !response.ok) throw new Error('Relayer HTTP request failed' + (response ? ' (' + response.status + ')' : ''));
        let data;
        if (typeof response.text === 'function') {
          const text = await response.text();
          if (text.length > 1048576) throw new Error('Relayer response is too large');
          data = JSON.parse(text);
        } else {
          data = await response.json();
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid relayer response');
        return data;
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('Relayer request timed out');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function read(provider, to, iface, method, args = []) {
      const data = await provider.call({ to, data: iface.encodeFunctionData(method, args) });
      return iface.decodeFunctionResult(method, data);
    }

    async function cacheWrite(storage, key, data) {
      if (storage && storage.set) await storage.set(key, data);
    }

    async function registrations(provider, storage) {
      const registry = P.REGISTRY;
      const iface = new E.Interface(REGISTRY_ABI);
      const topic = iface.getEvent('RelayerRegistered').topicHash;
      const key = 'tornado-relayers-v' + CACHE_VERSION + '-' + registry.address.toLowerCase();
      const latest = await provider.getBlockNumber();
      const safeHead = Math.max(0, latest - CONFIRMATIONS);
      let cache = storage && storage.get ? await storage.get(key) : null;
      if (cache && (cache.version !== CACHE_VERSION || !Number.isSafeInteger(cache.lastBlock) ||
          !Array.isArray(cache.events) || cache.lastBlock < registry.deployedBlock - 1 || cache.lastBlock > safeHead)) cache = null;
      if (cache && cache.lastBlock >= registry.deployedBlock) {
        let header;
        try { header = await provider.getBlock(cache.lastBlock); } catch { /* Invalidate unverifiable cache. */ }
        if (!header || !header.hash || header.hash !== cache.lastHash) {
          cache = null;
          await cacheWrite(storage, key, null);
        }
      }
      if (!cache) cache = { version: CACHE_VERSION, lastBlock: registry.deployedBlock - 1, lastHash: null, events: [] };
      let fromBlock = cache.lastBlock + 1;
      let span = 250000;
      while (fromBlock <= safeHead) {
        const toBlock = Math.min(safeHead, fromBlock + span - 1);
        let logs;
        try {
          logs = await provider.getLogs({ address: registry.address, topics: [topic], fromBlock, toBlock });
        } catch (error) {
          if (span <= 16) throw new Error('Cannot synchronize Tornado relayer registrations');
          span = Math.max(16, Math.floor(span / 2));
          continue;
        }
        const next = [];
        for (const log of logs) {
          if (log.removed || (log.address && String(log.address).toLowerCase() !== registry.address.toLowerCase())) continue;
          const blockNumber = Number(log.blockNumber);
          if (!Number.isSafeInteger(blockNumber) || blockNumber < fromBlock || blockNumber > toBlock) throw new Error('Invalid registry event block');
          const parsed = iface.parseLog(log);
          const ensName = E.ensNormalize(parsed.args.ensName);
          const ensHash = E.namehash(ensName);
          if (ensHash.toLowerCase() !== parsed.args.relayer.toLowerCase()) throw new Error('Invalid registry ENS name');
          next.push({ ensName, ensHash, relayerAddress: address(parsed.args.relayerAddress), blockNumber,
            logIndex: Number(log.index ?? log.logIndex ?? 0) });
        }
        const header = await provider.getBlock(toBlock);
        if (!header || !/^0x[0-9a-fA-F]{64}$/.test(header.hash)) throw new Error('Cannot verify relayer registry checkpoint');
        cache = { version: CACHE_VERSION, lastBlock: toBlock, lastHash: header.hash, events: cache.events.concat(next) };
        await cacheWrite(storage, key, cache);
        fromBlock = toBlock + 1;
        span = Math.min(1000000, span * 2);
      }
      const distinct = new Map();
      for (const event of cache.events.slice().sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)) {
        if (event && event.ensHash === E.namehash(event.ensName)) distinct.set(event.ensHash, event);
      }
      return [...distinct.values()];
    }

    async function candidates(pool, provider, storage) {
      const registry = P.REGISTRY;
      const registryIface = new E.Interface(REGISTRY_ABI);
      const aggregatorIface = new E.Interface(AGGREGATOR_ABI);
      const events = await registrations(provider, storage);
      if (!events.length) return [];
      const currentMinimum = (await read(provider, registry.address, registryIface, 'minStakeAmount'))[0];
      const minimumStake = BigInt(currentMinimum) > BigInt(registry.minimumStake) ? BigInt(currentMinimum) : BigInt(registry.minimumStake);
      const subdomainIndex = registry.subdomains.indexOf(pool.network.subdomain);
      const mainnetIndex = registry.subdomains.indexOf(P.networks[1].subdomain);
      if (subdomainIndex < 0 || mainnetIndex < 0) throw new Error('Unsupported relayer ENS subdomain');
      const result = [];
      for (let offset = 0; offset < events.length; offset += 40) {
        const chunk = events.slice(offset, offset + 40);
        const data = (await read(provider, registry.aggregator, aggregatorIface, 'relayersData',
          [chunk.map((event) => event.ensHash), registry.subdomains]))[0];
        if (data.length !== chunk.length) throw new Error('Invalid relayer aggregator response');
        data.forEach((item, index) => {
          const event = chunk[index];
          const host = item.records[subdomainIndex];
          const mainnetHost = item.records[mainnetIndex];
          if (item.isRegistered !== true || BigInt(item.balance) < minimumStake ||
              String(item.owner).toLowerCase() !== event.relayerAddress.toLowerCase() ||
              typeof host !== 'string' || !host || !mainnetHost || host.includes('://')) return;
          let url;
          try { url = urlBase('https://' + host); } catch { return; }
          result.push({ url, ensName: event.ensName, registeredAddress: event.relayerAddress,
            stakeBalance: item.balance.toString() });
        });
      }
      return result;
    }

    async function status(pool, candidate) {
      const url = urlBase(candidate.url);
      const data = await json(url + 'status');
      if (!Number.isSafeInteger(Number(data.netId)) || Number(data.netId) !== pool.chainId) throw new Error('Relayer serves a different network');
      if (!data.health || (data.health.status !== 'true' && data.health.status !== true)) throw new Error('Relayer is unhealthy');
      const serviceFee = data.tornadoServiceFee;
      if (typeof serviceFee !== 'number' || !Number.isFinite(serviceFee) || serviceFee < 0 || serviceFee > 20) throw new Error('Invalid relayer service fee');
      const reward = address(data.rewardAccount);
      if (pool.chainId === 1 && candidate.registeredAddress && reward.toLowerCase() !== candidate.registeredAddress.toLowerCase()) {
        throw new Error('Relayer reward account does not match its registration');
      }
      const instance = data.instances && data.instances[pool.currency];
      if (!instance || !instance.instanceAddress || Number(instance.decimals) !== pool.decimals ||
          typeof instance.instanceAddress[pool.amount] !== 'string' ||
          address(instance.instanceAddress[pool.amount]) !== pool.address) throw new Error('Relayer does not support this pool');
      if (!pool.native && address(instance.tokenAddress) !== address(pool.token.address)) throw new Error('Relayer token contract does not match');
      if (data.currentQueue !== undefined && (!Number.isFinite(Number(data.currentQueue)) || Number(data.currentQueue) < 0 || Number(data.currentQueue) > 5)) {
        throw new Error('Relayer queue is unavailable');
      }
      const ethPrices = {};
      if (!pool.native) {
        const price = data.ethPrices && data.ethPrices[pool.currency];
        if (typeof price !== 'string' || !/^[1-9][0-9]{0,59}$/.test(price)) throw new Error('Missing relayer token exchange rate');
        ethPrices[pool.currency] = price;
      }
      const gasPrices = {};
      if (data.gasPrices && typeof data.gasPrices.fast === 'number' && Number.isFinite(data.gasPrices.fast) &&
          data.gasPrices.fast >= 0 && data.gasPrices.fast <= 1e9) gasPrices.fast = data.gasPrices.fast;
      return { ...candidate, url, address: reward, serviceFee, tornadoServiceFee: serviceFee,
        ethPrices, gasPrices, checkedAt: Date.now(), chainId: pool.chainId, poolAddress: pool.address,
        amount: pool.amount, amountWei: pool.value.toString(), currency: pool.currency, decimals: pool.decimals };
    }

    async function select({ pool: rawPool, provider, mainnetProvider, storage, customUrl, url }) {
      const pool = poolInfo(rawPool);
      await verifyNetwork(provider, pool.chainId);
      const custom = customUrl || url;
      if (custom) return status(pool, { url: urlBase(custom), registered: false });
      const discoveryProvider = mainnetProvider || (pool.chainId === 1 ? provider : null);
      await verifyNetwork(discoveryProvider, P.REGISTRY.chainId);
      const list = await candidates(pool, discoveryProvider, storage);
      if (!list.length) throw new Error('No registered Tornado relayer supports this network');
      let cursor = 0;
      let found = false;
      const probe = async () => {
        while (!found && cursor < list.length) {
          const candidate = list[cursor++];
          try {
            const relayer = await status(pool, { ...candidate, registered: true });
            found = true;
            return relayer;
          } catch { /* Try the next independently registered endpoint. */ }
        }
        throw new Error('No usable Tornado relayer');
      };
      try { return await Promise.any(Array.from({ length: Math.min(4, list.length) }, probe)); }
      catch { throw new Error('No healthy Tornado relayer supports this pool; set a compatible relayer URL and retry'); }
    }

    const ceil = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
    async function quote({ pool: rawPool, provider, relayer, refund = '0' }) {
      const pool = poolInfo(rawPool);
      await verifyNetwork(provider, pool.chainId);
      if (!relayer || Number(relayer.chainId) !== pool.chainId || address(relayer.poolAddress) !== pool.address) throw new Error('Relayer quote belongs to a different pool');
      address(relayer.address);
      urlBase(relayer.url);
      const serviceFee = relayer.serviceFee ?? relayer.tornadoServiceFee;
      if (typeof serviceFee !== 'number' || !Number.isFinite(serviceFee) || serviceFee < 0 || serviceFee > 20) throw new Error('Invalid relayer service fee');
      const nativeRefund = uint(refund);
      if (pool.native && nativeRefund !== 0n) throw new Error('Native-coin pools do not support a refund');
      const feeData = await provider.getFeeData();
      let gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
      if (!gasPrice || BigInt(gasPrice) <= 0n) throw new Error('Cannot obtain withdrawal gas price');
      gasPrice = BigInt(gasPrice);
      if (relayer.gasPrices && Number.isFinite(relayer.gasPrices.fast) && relayer.gasPrices.fast > 0) {
        const advertised = E.parseUnits(relayer.gasPrices.fast.toFixed(9), 9);
        if (advertised > gasPrice) gasPrice = advertised;
      }
      const withdrawGas = pool.chainId === 42161 ? 1900000n : pool.chainId === 10 ? 440000n : 550000n;
      let networkFee = ceil(gasPrice * withdrawGas * 120n, 100n);
      if (pool.chainId === 10) {
        const oracle = new E.Interface(['function getL1Fee(bytes) view returns (uint256)']);
        const tx = E.Transaction.from({ to: pool.address, chainId: 10, type: 0, nonce: 1,
          gasLimit: withdrawGas, gasPrice, data: '0x' + 'ff'.repeat(804) }).unsignedSerialized;
        const l1 = (await read(provider, '0x420000000000000000000000000000000000000F', oracle,
          'getL1Fee', [E.concat([tx, '0x' + 'ff'.repeat(68)])]))[0];
        networkFee += ceil(BigInt(l1) * 150n, 100n);
      }
      // A millionth of one percentage point, rounded upward, avoids floating-point amount arithmetic.
      const feeRate = BigInt(Math.ceil(serviceFee * 1000000));
      const service = ceil(pool.value * feeRate, 100000000n);
      let fee;
      if (pool.native) fee = networkFee + service;
      else {
        const rawPrice = relayer.ethPrices && relayer.ethPrices[pool.currency];
        if (typeof rawPrice !== 'string' || !/^[1-9][0-9]{0,59}$/.test(rawPrice)) throw new Error('Missing relayer token exchange rate');
        fee = ceil((networkFee + nativeRefund) * (10n ** BigInt(pool.decimals)), BigInt(rawPrice)) + service;
      }
      if (fee <= 0n || fee >= pool.value || fee * 5n > pool.value) throw new Error('Total relayer fee exceeds the 20% limit for this pool');
      return { fee: fee.toString(), refund: nativeRefund.toString(), gasPrice: gasPrice.toString(),
        withdrawGas: withdrawGas.toString(), networkFee: networkFee.toString() };
    }

    function jobId(value) {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid relayer job ID');
      return value;
    }

    async function submit({ relayer, proof, args, contract }) {
      requirements();
      const url = urlBase(relayer.url);
      if (address(contract) !== address(relayer.poolAddress)) throw new Error('Withdrawal contract differs from the selected pool');
      if (typeof proof !== 'string' || !/^0x[0-9a-fA-F]{512}$/.test(proof) || !Array.isArray(args) || args.length !== 6) {
        throw new Error('Invalid public withdrawal proof');
      }
      if (!args.slice(0, 2).every((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))) throw new Error('Invalid proof root or nullifier hash');
      const publicAddress = (value) => {
        if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]{40}|0x0{24}[0-9a-fA-F]{40})$/.test(value)) throw new Error('Invalid proof recipient address');
        return address('0x' + value.slice(-40));
      };
      publicAddress(args[2]);
      if (publicAddress(args[3]) !== address(relayer.address)) throw new Error('Proof names a different relayer');
      const fee = uint(args[4]);
      const refund = uint(args[5]);
      if (fee <= 0n || fee * 5n > uint(relayer.amountWei) || (P.networks[relayer.chainId].currency === relayer.currency && refund !== 0n)) {
        throw new Error('Invalid public withdrawal fee');
      }
      // Construct an explicit whitelist: no session, note, secret, or private key can enter the HTTP body.
      const body = JSON.stringify({ contract: address(contract), proof,
        args: [args[0], args[1], publicAddress(args[2]), publicAddress(args[3]), fee.toString(), refund.toString()] });
      const data = await json(url + 'v1/tornadoWithdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      return { id: jobId(data.id) };
    }

    async function job(options, legacyId) {
      const url = urlBase(options.url);
      const id = jobId(legacyId === undefined ? options.id : legacyId);
      const data = await json(url + 'v1/jobs/' + id);
      if (typeof data.status !== 'string' || !/^[A-Z_]{1,40}$/.test(data.status)) throw new Error('Invalid relayer job status');
      if (data.txHash !== undefined && data.txHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(data.txHash)) throw new Error('Invalid relayer transaction hash');
      if (data.status === 'CONFIRMED' && !data.txHash) throw new Error('Confirmed relayer job is missing a transaction hash');
      if (data.confirmations !== undefined && (!Number.isSafeInteger(Number(data.confirmations)) || Number(data.confirmations) < 0)) throw new Error('Invalid relayer confirmations');
      return { id, status: data.status, txHash: data.txHash || null,
        confirmations: Number(data.confirmations || 0), failedReason: typeof data.failedReason === 'string' ? data.failedReason.slice(0, 300) : '' };
    }

    return Object.freeze({ select, quote, submit, job, create });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = create({ ethers: require('./vendor/ethers.umd.min.js'), pools: require('./tornado-pools.js') });
  } else {
    root.TornadoRelayer = create();
  }
})(typeof globalThis === 'undefined' ? window : globalThis);
