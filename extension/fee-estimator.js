/* global module */
'use strict';
(function (root) {
  // Public price requests contain only an allowlisted native-coin identifier.
  // CoinGecko: https://docs.coingecko.com/demo/reference/simple-price
  // Keyless tier: https://www.coingecko.com/en/api/pricing
  // Fallback: https://docs.llama.fi/list-your-project/how-to-request-token-pricing
  const PRICE_IDS = Object.freeze({
    1: 'ethereum', 10: 'ethereum', 42161: 'ethereum', 8453: 'ethereum',
    59144: 'ethereum', 324: 'ethereum', 534352: 'ethereum',
    56: 'binancecoin', 137: 'polygon-ecosystem-token', 43114: 'avalanche-2',
    5000: 'mantle', 100: 'xdai',
  });
  const SEPARATE_L1 = new Set([10, 8453, 59144, 324, 534352, 5000]);
  const MIX_POOLS = Object.freeze({
    1: '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc',
    10: '0x84443CFd09A48AF6eF360C6976C5392aC5023a1F',
    42161: '0x84443CFd09A48AF6eF360C6976C5392aC5023a1F',
  });
  const SAMPLE_ADDRESS = '0x1111111111111111111111111111111111111111';
  const SAMPLE_RELAYER = '0x2222222222222222222222222222222222222222';
  const LIMIT = (1n << 256n) - 1n;
  const ceil = (n, d) => (n + d - 1n) / d;

  function uint(value, allowZero = true) {
    if (typeof value !== 'bigint' && !(typeof value === 'string' && /^(?:0x[\da-fA-F]+|\d+)$/.test(value))) {
      throw new Error('feeInvalidAmount');
    }
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > LIMIT || (!allowZero && parsed === 0n)) throw new Error('feeInvalidAmount');
    return parsed;
  }

  function create(deps = {}) {
    const E = deps.ethers || root.ethers;
    const fetcher = deps.fetch || (root.fetch && root.fetch.bind(root));
    const now = deps.now || Date.now;
    const timeoutMs = deps.timeoutMs ?? 8000;
    const priceTtlMs = deps.priceTtlMs ?? 60000;
    const priceMaxAgeMs = deps.priceMaxAgeMs ?? 15 * 60000;
    const priceRetryMs = deps.priceRetryMs ?? 30000;
    const cached = new Map();
    const pending = new Map();
    const failedAt = new Map();

    function coinId(chain) { return PRICE_IDS[Number(chain && chain.id)] || null; }
    function unavailable() {
      return { usd: null, status: 'unavailable', source: null, sourceUrl: null, updatedAt: null, fetchedAt: null };
    }
    function validQuote(usd, timestamp, source, sourceUrl) {
      const at = now();
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || usd > 1e12 ||
          !Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('feeInvalidPrice');
      const updatedAt = timestamp * 1000;
      if (updatedAt > at + 5 * 60000 || at - updatedAt > priceMaxAgeMs) throw new Error('feePriceExpired');
      return { usd, source, sourceUrl, updatedAt, fetchedAt: at,
        status: at - updatedAt > priceTtlMs ? 'stale' : 'fresh' };
    }
    function cachedQuote(entry, forceStale = false) {
      if (!entry || now() - entry.updatedAt > priceMaxAgeMs || now() - entry.fetchedAt > priceMaxAgeMs) return unavailable();
      return { ...entry, status: forceStale || now() - entry.updatedAt > priceTtlMs ? 'stale' : 'fresh' };
    }

    async function requestJson(url) {
      if (!fetcher) throw new Error('feePriceUnavailable');
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetcher(url, { method: 'GET', signal: controller.signal,
              credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
            if (!response || !response.ok) throw new Error('feePriceUnavailable');
            let data;
            if (typeof response.text === 'function') {
              const text = await response.text();
              if (text.length > 1048576) throw new Error('feeInvalidPrice');
              data = JSON.parse(text);
            } else data = await response.json();
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('feeInvalidPrice');
            return data;
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('feePriceUnavailable')); }, timeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }

    async function getUsdPrice(chain, options = {}) {
      const id = coinId(chain);
      if (!id) return unavailable();
      const old = cached.get(id);
      if (!options.force && old && now() - old.fetchedAt < priceTtlMs) return cachedQuote(old);
      if (!options.force && failedAt.has(id) && now() - failedAt.get(id) < priceRetryMs) return cachedQuote(old, true);
      if (pending.has(id)) return pending.get(id);
      const promise = (async () => {
        try {
          let quote;
          try {
            const query = new URLSearchParams({ ids: id, vs_currencies: 'usd', include_last_updated_at: 'true' });
            const data = await requestJson('https://api.coingecko.com/api/v3/simple/price?' + query);
            quote = validQuote(data[id] && data[id].usd, data[id] && data[id].last_updated_at,
              'CoinGecko', 'https://www.coingecko.com/en/api');
          } catch {
            const key = 'coingecko:' + id;
            const data = await requestJson('https://coins.llama.fi/prices/current/' + key);
            const item = data.coins && data.coins[key];
            if (item && item.confidence !== undefined &&
                (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0.8 || item.confidence > 1)) {
              throw new Error('feeInvalidPrice');
            }
            quote = validQuote(item && item.price, item && item.timestamp, 'DefiLlama', 'https://defillama.com');
          }
          cached.set(id, quote);
          failedAt.delete(id);
          return quote;
        } catch {
          failedAt.set(id, now());
          return cachedQuote(old, true);
        } finally { pending.delete(id); }
      })();
      pending.set(id, promise);
      return promise;
    }

    async function estimate(input) {
      if (!E) throw new Error('feeDependenciesUnavailable');
      const { chain, provider } = input;
      const chainId = Number(chain && chain.id);
      const mode = input.mode || 'normal';
      const asset = input.asset || 'native';
      if (!chain || !Number.isSafeInteger(chainId) || chainId < 1 || !provider || !['normal', 'tornado'].includes(mode)) {
        throw new Error('feeInvalidContext');
      }
      if (typeof provider.getNetwork === 'function') {
        const network = await provider.getNetwork();
        if (BigInt(network.chainId) !== BigInt(chainId)) throw new Error('feeWrongNetwork');
      }
      const warnings = new Set();
      const components = [];
      let reference = false;
      let l1Complete = true;
      let serviceFeeKnown = true;
      let serviceWei = 0n;
      const l1Memo = new Map();
      const gasData = input.gasPriceWei === undefined ? await provider.getFeeData() : null;
      // Matches the application's 20% legacy gas-price reserve. Explicit prices
      // are already budgeted by the caller and must not receive the margin twice.
      const gasPrice = input.gasPriceWei !== undefined ? uint(input.gasPriceWei, false) :
        ceil(uint(gasData.gasPrice ?? gasData.maxFeePerGas, false) * 120n, 100n);
      const knownAddress = (value) => typeof value === 'string' && E.isAddress(value) && value !== E.ZeroAddress;
      const dest = knownAddress(input.dest) ? E.getAddress(input.dest) : SAMPLE_ADDRESS;
      const source = knownAddress(input.sourceAddress) ? E.getAddress(input.sourceAddress) : E.ZeroAddress;
      const second = knownAddress(input.secondAddress) ? E.getAddress(input.secondAddress) : SAMPLE_ADDRESS;
      const gasWallet = knownAddress(input.gasWalletAddress) ? E.getAddress(input.gasWalletAddress) : SAMPLE_RELAYER;
      const needsL1 = !!chain.l1Oracle || SEPARATE_L1.has(chainId);
      const margin = (value) => ceil(uint(value, false) * 130n, 100n);

      async function estimatedGas(request, fallback) {
        try { return { gas: margin(await provider.estimateGas(request)), estimated: false }; }
        catch {
          warnings.add('feeFallback');
          // Nitro puts L1 data gas inside estimateGas(). A plain execution-gas
          // fallback cannot pretend that this missing part has been measured.
          if (chainId === 42161) { l1Complete = false; warnings.add('feeL1Unavailable'); }
          return { gas: fallback, estimated: true };
        }
      }
      async function transferGas(from, to, value, destinationKnown) {
        const request = { from, to, value };
        if (!destinationKnown) {
          reference = true;
          if (chainId !== 42161) return { request, gas: 21000n, estimated: true };
          return { request, ...await estimatedGas(request, 21000n) };
        }
        let code;
        try { code = await provider.getCode(to); }
        catch { warnings.add('feeFallback'); return { request, gas: 100000n, estimated: true }; }
        if (code === '0x' && chainId !== 42161) return { request, gas: 21000n, estimated: false };
        return { request, ...await estimatedGas(request, code === '0x' ? 21000n : 100000n) };
      }
      async function add(kind, request, gas, estimated, count = 1) {
        const execution = gas * gasPrice * BigInt(count);
        let l1 = 0n;
        if (needsL1) {
          try {
            if (typeof input.estimateL1Fee !== 'function') throw new Error('feeL1Unavailable');
            const transaction = { ...request, type: 0, chainId, gasLimit: gas, gasPrice };
            const key = JSON.stringify(Object.fromEntries(Object.keys(transaction).sort().map((name) => [name, transaction[name]])),
              (_, value) => typeof value === 'bigint' ? value.toString() : value);
            if (!l1Memo.has(key)) l1Memo.set(key, Promise.resolve().then(async () =>
              uint(await input.estimateL1Fee(provider, chain, transaction))));
            l1 = await l1Memo.get(key) * BigInt(count);
          } catch {
            l1 = null;
            l1Complete = false;
            warnings.add('feeL1Unavailable');
          }
        }
        const total = execution + (l1 ?? 0n);
        const component = { kind, count, gasUnits: gas.toString(), executionWei: execution.toString(),
          l1Wei: l1 === null ? null : l1.toString(), totalWei: total.toString(), estimated };
        components.push(component);
        return component;
      }

      let noteCount = 0;
      if (mode === 'normal') {
        if (asset === 'native') {
          const transfer = await transferGas(source, dest, input.amountWei !== undefined ? uint(input.amountWei, false) : 1n, knownAddress(input.dest));
          await add('transfer', transfer.request, transfer.gas, transfer.estimated);
        } else {
          if (!E.isAddress(asset)) throw new Error('feeInvalidAsset');
          const token = new E.Interface(['function transfer(address,uint256)']);
          const request = { from: source, to: E.getAddress(asset), data: token.encodeFunctionData('transfer',
            [dest, input.amountWei !== undefined ? uint(input.amountWei, false) : 1n]) };
          const gas = await estimatedGas(request, 130000n);
          const transfer = await add('tokenTransfer', request, gas.gas, gas.estimated);
          if (input.includeFunding !== false) {
            // The top-up principal is not a network fee and is never added to
            // totals. Only the two extra transactions' gas belongs here.
            const funding = await transferGas(gasWallet, source === E.ZeroAddress ? SAMPLE_ADDRESS : source,
              ceil(BigInt(transfer.totalWei) * 130n, 100n), knownAddress(input.sourceAddress));
            await add('gasFunding', funding.request, funding.gas, funding.estimated);
            if (input.includeReturn !== false) {
              const refund = await transferGas(source, gasWallet, 1n, knownAddress(input.gasWalletAddress));
              await add('gasReturn', refund.request, refund.gas, refund.estimated);
            }
          }
        }
      } else {
        if (asset !== 'native' || chain.symbol !== 'ETH' || !MIX_POOLS[chainId]) throw new Error('feeUnsupported');
        const supplied = Array.isArray(input.plan) && input.plan.length > 0;
        const plan = supplied ? input.plan : [{ amount: '100000000000000000', address: MIX_POOLS[chainId] }];
        if (plan.length > 100) throw new Error('feeInvalidContext');
        reference = !supplied;
        if (reference) warnings.add('feeReference');
        noteCount = plan.length;
        const iface = new E.Interface(['function deposit(bytes32)',
          'function withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)']);
        const fullWord = '0x' + 'ff'.repeat(32);
        const proof = '0x' + 'ff'.repeat(256);
        const withdrawalGas = chainId === 42161 ? 1900000n : chainId === 10 ? 440000n : 550000n;
        for (let i = 0; i < plan.length; i++) {
          const entry = plan[i];
          const amount = uint(entry.amountWei ?? entry.amount, false);
          const pool = knownAddress(entry.address) ? E.getAddress(entry.address) : MIX_POOLS[chainId];
          await add('deposit', { from: source, to: pool, value: amount,
            data: iface.encodeFunctionData('deposit', [fullWord]) }, 1400000n, true);
          await add('withdrawal', { from: SAMPLE_RELAYER, to: pool,
            data: iface.encodeFunctionData('withdraw', [proof, fullWord, fullWord, second, SAMPLE_RELAYER, 1n, 0n]) },
          ceil(withdrawalGas * 120n, 100n), true);
          const note = input.notes && input.notes[i];
          const explicit = note && note.serviceFeeWei;
          const relayer = note && (note.withdrawalIntent && note.withdrawalIntent.relayer || note.relayer);
          const rate = relayer && (relayer.serviceFee ?? relayer.tornadoServiceFee);
          if (explicit !== undefined && explicit !== null) serviceWei += uint(explicit);
          else if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 20) {
            serviceWei += ceil(amount * BigInt(Math.ceil(rate * 1000000)), 100000000n);
          } else serviceFeeKnown = false;
        }
        const transfer = await transferGas(second, dest, 1n, knownAddress(input.dest));
        await add('finalTransfer', transfer.request, transfer.gas, transfer.estimated);
        if (!serviceFeeKnown) warnings.add('feeRelayerUnknown');
      }

      const networkWei = components.reduce((sum, item) => sum + BigInt(item.totalWei), 0n);
      const totalWei = networkWei + serviceWei;
      const price = input.price || await getUsdPrice(chain);
      const priceValid = price && typeof price.usd === 'number' && Number.isFinite(price.usd) && price.usd > 0 &&
        ['fresh', 'stale'].includes(price.status);
      if (!priceValid) warnings.add('feePriceUnavailable');
      else if (price.status === 'stale') warnings.add('feePriceStale');
      const usd = (value) => {
        if (!priceValid) return null;
        const converted = Number(E.formatUnits(value, 18)) * price.usd;
        return Number.isFinite(converted) ? converted : null;
      };
      return {
        mode, symbol: chain.symbol, gasPriceWei: gasPrice.toString(),
        networkWei: networkWei.toString(), serviceWei: serviceFeeKnown ? serviceWei.toString() : null,
        knownServiceWei: serviceWei.toString(), totalWei: totalWei.toString(),
        complete: l1Complete && serviceFeeKnown, l1Complete, serviceFeeKnown, reference, noteCount,
        scope: mode === 'normal' ? 'transfer' : reference ? 'per-deposit-reference' : 'batch',
        components, warnings: [...warnings], price: priceValid ? { ...price } : unavailable(),
        networkUsd: usd(networkWei), serviceUsd: serviceFeeKnown ? usd(serviceWei) : null,
        totalUsd: usd(totalWei), nativeAmount: E.formatUnits(totalWei, 18),
      };
    }
    return { estimate, getUsdPrice, priceId: coinId };
  }

  let defaultEstimator;
  const getDefault = () => defaultEstimator || (defaultEstimator = create());
  const api = { create, PRICE_IDS,
    estimate: (input) => getDefault().estimate(input),
    getUsdPrice: (chain, options) => getDefault().getUsdPrice(chain, options) };
  root.FeeEstimator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
