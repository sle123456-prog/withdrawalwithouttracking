/* global ethers, qrcode, CHAINS, chrome, t, applyI18n, LANG:writable, vault, vaultCreate, vaultAddMethod,
   vaultUnlock, vaultVerify, vaultSeal, vaultOpen, vaultForget, vaultPasskeySupported */
'use strict';

const POLL_MS = 6000;
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256)', // 不声明返回值，兼容 USDT 这类不返回 bool 的代币
];
const ORACLE_ABI = ['function getL1Fee(bytes) view returns (uint256)'];
const erc20 = new ethers.Interface(ERC20_ABI);

const $ = (id) => document.getElementById(id);
const chainById = (id) => CHAINS.find((c) => c.id === Number(id));

// ---------- 存储：插件环境用 chrome.storage.local，否则退回 localStorage ----------
const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const store = {
  async get(key) {
    if (hasChromeStorage) return (await chrome.storage.local.get(key))[key];
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  },
  async set(key, value) {
    if (hasChromeStorage) return chrome.storage.local.set({ [key]: value });
    localStorage.setItem(key, JSON.stringify(value));
  },
  async remove(key) {
    if (hasChromeStorage) return chrome.storage.local.remove(key);
    localStorage.removeItem(key);
  },
};

let active = null; // 当前会话
let gasWallet = null; // { privateKey, address }，代付 gas 的钱包
let history = []; // 已重置的旧会话（保留私钥以便取回资金）
let timer = null;
let busy = false;
let provider = null;
let providerKey = '';

// 含私钥的三项数据统一落盘：开启加密时整体加密成 vaultData，否则按原来的明文键保存。
// 串行执行，避免并发写入互相覆盖。
let persistChain = Promise.resolve();
function persist() {
  persistChain = persistChain.catch(() => {}).then(async () => {
    if (vault.enabled) {
      await store.set('vaultData', await vaultSeal({ active, history, gasWallet }));
    } else {
      await store.set('active', active);
      await store.set('history', history);
      await store.set('gasWallet', gasWallet);
    }
  });
  return persistChain;
}
const saveActive = persist;
const saveHistory = persist;

// ---------- 链访问 ----------
const rpcKey = (s) => s.chainId + '|' + (s.rpc ? [s.rpc] : chainById(s.chainId).rpcs).join(',');

// 当前会话用的 provider，带缓存
async function getProvider(s) {
  const key = rpcKey(s);
  if (provider && providerKey === key) return provider;
  provider = await openProvider(s);
  providerKey = key;
  return provider;
}

// 新建一个连接（不缓存），依次尝试各个 RPC 并核对 chainId
async function openProvider(s) {
  const chain = chainById(s.chainId);
  const urls = s.rpc ? [s.rpc] : chain.rpcs;
  let lastErr;
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
      const net = await p.getNetwork();
      if (net.chainId !== BigInt(chain.id)) {
        p.destroy();
        throw new Error(t('eChainId', { got: String(net.chainId), chain: chain.name, id: chain.id }));
      }
      return p;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(t('eRpc', { err: shortErr(lastErr) }));
}

function shortErr(e) {
  const m = (e && (e.shortMessage || e.message)) || String(e);
  return m.length > 180 ? m.slice(0, 180) + '…' : m;
}

// 用 legacy 交易 + 略高于当前的 gasPrice：手续费上限确定，便于把原生币精确转空。
async function getGasPrice(p) {
  const fd = await p.getFeeData();
  const gp = fd.gasPrice ?? fd.maxFeePerGas;
  if (!gp) throw new Error(t('eGasPrice'));
  return (gp * 120n) / 100n;
}

// OP Stack / Scroll 的 L1 数据费（估算值 ×1.5 作为预留）
async function l1Fee(p, chain, tx) {
  if (!chain.l1Oracle) return 0n;
  try {
    const raw = ethers.Transaction.from({ ...tx, type: 0, chainId: chain.id, nonce: 1 }).unsignedSerialized;
    const padded = ethers.concat([raw, '0x' + 'ff'.repeat(68)]); // 补上签名的长度
    const fee = await new ethers.Contract(chain.l1Oracle, ORACLE_ABI, p).getL1Fee(padded);
    return (fee * 150n) / 100n;
  } catch {
    return 0n;
  }
}

const isFundsError = (e) => /insufficient funds|INSUFFICIENT_FUNDS|exceeds balance|not enough/i.test(
  (e && (e.code + ' ' + e.message + ' ' + (e.info ? JSON.stringify(e.info) : ''))) || ''
);

// 把中转地址上的原生币全部转给 to（默认 B，扣除手续费）。返回 tx hash；余额不够付手续费时返回 null。
async function sweepNative(s, p, wallet, to = s.dest) {
  const chain = chainById(s.chainId);
  const gasPrice = await getGasPrice(p);
  let gasLimit = 21000n;
  try {
    const est = await p.estimateGas({ from: s.address, to, value: 1n });
    if (est > 21000n) gasLimit = (est * 120n) / 100n;
  } catch { /* 余额极小时估算可能失败，沿用 21000 */ }
  const l1 = await l1Fee(p, chain, { to, value: 10n ** 18n, gasLimit, gasPrice });
  const baseReserve = gasLimit * gasPrice + l1;

  for (let attempt = 0; attempt < 4; attempt++) {
    const bal = await p.getBalance(s.address);
    const reserve = baseReserve + (baseReserve * BigInt(attempt)) / 2n;
    const value = bal - reserve;
    if (value <= 0n) return null;
    try {
      const tx = await wallet.sendTransaction({ to, value, gasLimit, gasPrice, type: 0 });
      await tx.wait(1);
      return { hash: tx.hash, value };
    } catch (e) {
      if (!isFundsError(e) || attempt === 3) throw e;
    }
  }
  return null;
}

// 把代币全部转给 B。gas 不够时返回 { needGas }。
async function forwardToken(s, p, wallet, balance) {
  const chain = chainById(s.chainId);
  const data = erc20.encodeFunctionData('transfer', [s.dest, balance]);
  const gasPrice = await getGasPrice(p);
  const est = await p.estimateGas({ from: s.address, to: s.asset, data });
  const gasLimit = (est * 130n) / 100n;
  const l1 = await l1Fee(p, chain, { to: s.asset, data, gasLimit, gasPrice });
  const need = gasLimit * gasPrice + l1;
  const native = await p.getBalance(s.address);
  if (native < need) {
    // 建议充值额比预计多 30%，保证够用
    return { needGas: (need * 130n) / 100n - native };
  }
  const tx = await wallet.sendTransaction({ to: s.asset, data, gasLimit, gasPrice, type: 0 });
  const rc = await tx.wait(1);
  if (!rc || rc.status !== 1) throw new Error(t('eTokenTx', { hash: tx.hash }));
  const left = await new ethers.Contract(s.asset, ERC20_ABI, p).balanceOf(s.address);
  if (left >= balance) throw new Error(t('eTokenBal', { hash: tx.hash }));
  return { hash: tx.hash };
}

// 由 Gas 钱包给中转地址垫付 amount 的原生币。Gas 钱包余额不足时返回 { short }。
async function fundGas(s, p, amount) {
  const chain = chainById(s.chainId);
  const gw = new ethers.Wallet(gasWallet.privateKey, p);
  const gasPrice = await getGasPrice(p);
  let gasLimit = 21000n;
  try {
    const est = await p.estimateGas({ from: gw.address, to: s.address, value: amount });
    if (est > 21000n) gasLimit = (est * 120n) / 100n;
  } catch { /* 余额不足时估算会失败，下面按余额判断 */ }
  const l1 = await l1Fee(p, chain, { to: s.address, value: amount, gasLimit, gasPrice });
  const cost = amount + gasLimit * gasPrice + l1;
  const bal = await p.getBalance(gw.address);
  if (bal < cost) return { short: cost - bal };
  const tx = await gw.sendTransaction({ to: s.address, value: amount, gasLimit, gasPrice, type: 0 });
  await tx.wait(1);
  return { hash: tx.hash };
}

// ---------- 手续费预估 ----------
// 代币转出按典型的 ERC-20 transfer（约 65000 gas，含 30% 余量）加上 Gas 钱包垫付那笔转账估算。
const TOKEN_TRANSFER_GAS = 84500n;
const priceCache = {}; // priceId -> { usd, at }

async function nativeUsdPrice(chain) {
  const hit = priceCache[chain.priceId];
  if (hit && Date.now() - hit.at < 60000) return hit.usd;
  const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' + chain.priceId);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const usd = ((await resp.json())[chain.priceId] || {}).usd;
  if (typeof usd !== 'number') throw new Error('no price');
  priceCache[chain.priceId] = { usd, at: Date.now() };
  return usd;
}

// 返回预计手续费（wei）。isToken=false：一笔原生币转账；true：Gas 钱包垫付 + 代币转账。
async function estimateFee(ctx, isToken) {
  const chain = chainById(ctx.chainId);
  const p = await getProvider(ctx);
  const gasPrice = await getGasPrice(p);
  const dummy = '0x000000000000000000000000000000000000dEaD';
  let fee = 21000n * gasPrice + await l1Fee(p, chain, { to: dummy, value: 10n ** 18n, gasLimit: 21000n, gasPrice });
  if (isToken) {
    const data = erc20.encodeFunctionData('transfer', [dummy, 10n ** 18n]);
    fee += TOKEN_TRANSFER_GAS * gasPrice +
      await l1Fee(p, chain, { to: dummy, data, gasLimit: TOKEN_TRANSFER_GAS, gasPrice });
  }
  return fee;
}

function fmtUsd(v) {
  return v >= 0.01 ? v.toFixed(2) : v.toPrecision(2);
}

let feeSeq = 0;
async function refreshFee() {
  const seq = ++feeSeq;
  const ctx = active || { chainId: Number($('chain').value), rpc: $('rpc').value.trim() };
  const isToken = active ? active.asset !== 'native' : $('asset').value !== 'native';
  const chain = chainById(ctx.chainId);
  const show = (text) => { if (seq === feeSeq) { $('feeEst').textContent = text; $('feeEstS').textContent = text; } };
  show(t('feeLoading'));
  try {
    const fee = await estimateFee(ctx, isToken);
    let text = t('feeValue', { amount: fmt(fee, 18), symbol: chain.symbol });
    show(text);
    try {
      const usd = await nativeUsdPrice(chain);
      text += t('feeUsd', { usd: fmtUsd(Number(ethers.formatEther(fee)) * usd) });
    } catch {
      text += t('feeNoUsd');
    }
    show(text);
  } catch (e) {
    show(t('feeFailed', { err: shortErr(e) }));
  }
}

// ---------- 主循环 ----------
async function tick() {
  if (!active || busy) return;
  busy = true;
  const s = active;
  try {
    const p = await getProvider(s);
    const chain = chainById(s.chainId);
    const wallet = new ethers.Wallet(s.privateKey, p);
    const native = await p.getBalance(s.address);
    let tokenBal = 0n;
    if (s.asset !== 'native') {
      tokenBal = await new ethers.Contract(s.asset, ERC20_ABI, p).balanceOf(s.address);
    }
    if (s !== active) return;
    showBalances(s, native, tokenBal);

    if (s.asset === 'native') {
      if (native > 0n) {
        setStatus(t('stReceived', { amount: fmt(native, 18), symbol: chain.symbol }));
        const r = await sweepNative(s, p, wallet);
        if (r) {
          addTx(s, r.hash, 'txForward', { amount: fmt(r.value, 18), symbol: chain.symbol });
          s.phase = 'done';
        } else if (s.phase !== 'done') {
          setStatus(t('stTooSmall'), 'warn');
        }
      }
    } else if (tokenBal > 0n) {
      setStatus(t('stReceived', { amount: fmt(tokenBal, s.decimals), symbol: s.assetSymbol }));
      let r = await forwardToken(s, p, wallet, tokenBal);
      delete s.gasShort;
      if (r.needGas && gasWallet) {
        setStatus(t('stFunding'));
        const f = await fundGas(s, p, r.needGas);
        if (f.short) {
          s.gasShort = f.short.toString();
        } else {
          addTx(s, f.hash, 'txFund', { amount: fmt(r.needGas, 18), symbol: chain.symbol });
          s.gasFunded = true;
          await saveActive();
          setStatus(t('stGasReady', { symbol: s.assetSymbol }));
          r = await forwardToken(s, p, wallet, tokenBal);
        }
      }
      if (r.needGas) {
        s.phase = 'need_gas';
        s.needGas = r.needGas.toString();
      } else {
        addTx(s, r.hash, 'txForward', { amount: fmt(tokenBal, s.decimals), symbol: s.assetSymbol });
        s.phase = 'done';
        delete s.needGas;
        // 剩余的 gas：Gas 钱包垫付过则退回 Gas 钱包；否则留在一次性地址，不转给 B
        if (s.gasFunded && gasWallet) {
          try {
            const r2 = await sweepNative(s, p, wallet, gasWallet.address);
            if (r2) addTx(s, r2.hash, 'txLeftGas', { amount: fmt(r2.value, 18), symbol: chain.symbol });
          } catch (e) { console.warn('sweep leftover failed', e); }
        }
      }
    }
    await saveActive();
    if (s === active) {
      renderPhase(s);
      if (s.txs.length !== s.shownTxs) { s.shownTxs = s.txs.length; refreshGasBalance(); }
      showBalances(s, await p.getBalance(s.address),
        s.asset === 'native' ? 0n : await new ethers.Contract(s.asset, ERC20_ABI, p).balanceOf(s.address));
    }
  } catch (e) {
    if (s === active) setStatus(t('stError', { err: shortErr(e) }), 'err');
    provider = null; // 下次换节点重连
  } finally {
    busy = false;
  }
}

function startLoop() {
  stopLoop();
  const run = async () => {
    await tick();
    timer = setTimeout(run, POLL_MS);
  };
  run();
}
function stopLoop() {
  clearTimeout(timer);
  timer = null;
}

// ---------- 界面 ----------
function fmt(v, decimals) {
  const t = ethers.formatUnits(v, decimals);
  const [i, f = ''] = t.split('.');
  const frac = f.slice(0, 8).replace(/0+$/, '');
  return frac ? i + '.' + frac : i;
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function renderPhase(s) {
  const chain = chainById(s.chainId);
  if (s.phase === 'done') {
    setStatus(t('stDone'), 'ok');
  } else if (s.phase === 'need_gas' && s.gasShort && gasWallet) {
    setStatus(t('stGasShort', {
      token: s.assetSymbol, chain: chain.name, addr: gasWallet.address,
      amount: fmt(BigInt(s.gasShort), 18), symbol: chain.symbol,
    }), 'warn');
  } else if (s.phase === 'need_gas') {
    setStatus(t('stNeedGas', {
      token: s.assetSymbol, amount: fmt(BigInt(s.needGas), 18), symbol: chain.symbol,
    }), 'warn');
  } else {
    setStatus(t('stWaiting', { sec: POLL_MS / 1000 }));
  }
}

function showBalances(s, native, tokenBal) {
  const chain = chainById(s.chainId);
  let t = fmt(native, 18) + ' ' + chain.symbol;
  if (s.asset !== 'native') t = fmt(tokenBal, s.decimals) + ' ' + s.assetSymbol + '  |  ' + t;
  $('balances').textContent = t;
}

function addTx(s, hash, key, vars) {
  s.txs.push({ hash, key, vars });
  if (s === active) renderTxs(s);
}

function renderTxs(s) {
  const chain = chainById(s.chainId);
  const ul = $('txs');
  ul.replaceChildren();
  for (const x of s.txs) {
    const li = document.createElement('li');
    li.append((x.key ? t(x.key, x.vars) : x.label) + '  '); // 旧版本记录里只有 label
    const a = document.createElement('a');
    a.href = chain.explorer + '/tx/' + x.hash;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = x.hash.slice(0, 10) + '…' + x.hash.slice(-6);
    li.append(a);
    ul.append(li);
  }
}

function fillAssets() {
  const chain = chainById($('chain').value);
  const sel = $('asset');
  sel.replaceChildren(new Option(chain.symbol + t('nativeSuffix'), 'native'));
  for (const [sym, addr] of Object.entries(chain.tokens)) sel.add(new Option(sym, addr));
  sel.add(new Option(t('otherToken'), 'custom'));
  $('customTokenRow').hidden = true;
}

function showSetup() {
  stopLoop();
  $('session').hidden = true;
  $('setup').hidden = false;
  $('setupError').hidden = true;
  $('dest').value = '';
  $('customToken').value = '';
  renderHistory();
  refreshFee();
}

function gasModeText(s) {
  if (s.asset === 'native') return t('gasModeNative');
  return t(gasWallet ? 'gasModeWallet' : 'gasModeSelf');
}

function showSession() {
  const s = active;
  const chain = chainById(s.chainId);
  $('setup').hidden = true;
  $('session').hidden = false;
  $('chainBadge').textContent = chain.name;
  $('withdrawHint').textContent = t('withdrawHint', { net: chain.name });
  $('address').textContent = s.address;
  $('destShow').textContent = s.dest;
  $('assetName').textContent = s.assetSymbol + (s.asset === 'native' ? t('nativeSuffix') : ' (' + s.asset + ')');
  $('gasMode').textContent = gasModeText(s);
  $('balances').textContent = '—';
  $('pk').hidden = true;
  $('pk').textContent = '';
  $('reveal').textContent = t('showKey');
  const qr = qrcode(0, 'M');
  qr.addData(s.address);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  renderTxs(s);
  renderPhase(s);
  renderHistory();
  startLoop();
  refreshFee();
}

function renderHistory() {
  $('historyBox').hidden = history.length === 0;
  const ul = $('history');
  ul.replaceChildren();
  history.slice().reverse().forEach((h) => {
    const chain = chainById(h.chainId);
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = h.address;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${chain.name} · ${h.assetSymbol} · ${new Date(h.createdAt).toLocaleString()} · ` +
      t(h.phase === 'done' ? 'done' : 'notDone') + ` · B: ${h.dest.slice(0, 8)}…${h.dest.slice(-6)}`;
    const bal = document.createElement('div');
    bal.className = 'bal';
    bal.dataset.id = h.id;
    paintHistBalance(bal, h);
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = t('restore');
    btn.onclick = () => restore(h.id);
    li.append(code, meta, bal, btn);
    ul.append(li);
  });
  if (history.some((h) => !histBal.has(h.id))) refreshHistoryBalances();
}

// ---------- 历史地址余额 ----------
const histBal = new Map(); // 会话 id -> { native, token } | { failed: true } | { loading: true }
let histSeq = 0;

function paintHistBalance(el, h) {
  const chain = chainById(h.chainId);
  const b = histBal.get(h.id);
  el.replaceChildren();
  el.classList.remove('has-funds');
  if (!b || b.loading) { el.textContent = t('histBalance', { text: t('histLoading') }); return; }
  if (b.failed) { el.textContent = t('histBalance', { text: t('histFailed') }); return; }
  let text = fmt(b.native, 18) + ' ' + chain.symbol;
  if (h.asset !== 'native') text = fmt(b.token, h.decimals) + ' ' + h.assetSymbol + '  |  ' + text;
  el.textContent = t('histBalance', { text });
  if (b.native > 0n || b.token > 0n) {
    el.classList.add('has-funds');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t('histHasFunds');
    el.append(' ', tag);
  }
}

const withTimeout = (promise, ms) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
]);

// 查询所有历史地址的余额。单个地址失败只影响它自己那一行。
async function refreshHistoryBalances() {
  const seq = ++histSeq;
  const items = history.slice();
  const repaint = (h) => {
    const el = [...document.querySelectorAll('#history .bal')].find((x) => x.dataset.id === h.id);
    if (el) paintHistBalance(el, h);
  };
  for (const h of items) { histBal.set(h.id, { loading: true }); repaint(h); }
  const conns = new Map(); // 同一条链 / RPC 共用一个连接
  await Promise.all(items.map(async (h) => {
    let result;
    try {
      const key = rpcKey(h);
      if (!conns.has(key)) conns.set(key, withTimeout(openProvider(h), 15000));
      const p = await conns.get(key);
      const native = await withTimeout(p.getBalance(h.address), 15000);
      const token = h.asset === 'native' ? 0n
        : await withTimeout(new ethers.Contract(h.asset, ERC20_ABI, p).balanceOf(h.address), 15000);
      result = { native, token };
    } catch {
      result = { failed: true };
    }
    if (seq !== histSeq) return;
    histBal.set(h.id, result);
    repaint(h);
  }));
  for (const c of conns.values()) c.then((p) => p.destroy()).catch(() => {});
}

async function archiveActive() {
  if (!active) return;
  history.push(active);
  histBal.delete(active.id); // 重新查询它的余额
  active = null;
  provider = null;
  await saveHistory();
  await saveActive();
}

async function restore(id) {
  const h = history.find((x) => x.id === id);
  if (!h) return;
  stopLoop();
  await archiveActive();
  history = history.filter((x) => x.id !== id);
  active = h;
  await saveHistory();
  await saveActive();
  showSession();
}

async function onStart() {
  const err = $('setupError');
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  const chain = chainById($('chain').value);
  const destRaw = $('dest').value.trim();
  if (!ethers.isAddress(destRaw)) return fail(t('eDest'));
  const dest = ethers.getAddress(destRaw);
  if (dest === ethers.ZeroAddress) return fail(t('eZero'));
  const rpc = $('rpc').value.trim();
  if (rpc && !/^https?:\/\//.test(rpc)) return fail(t('eRpcUrl'));

  const s = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    chainId: chain.id, dest, rpc, asset: 'native', assetSymbol: chain.symbol, decimals: 18,
    createdAt: Date.now(), phase: 'waiting', txs: [],
  };

  const btn = $('start');
  btn.disabled = true;
  try {
    let asset = $('asset').value;
    if (asset === 'custom') {
      const raw = $('customToken').value.trim();
      if (!ethers.isAddress(raw)) return fail(t('eTokenAddr'));
      asset = raw;
    }
    if (asset !== 'native') {
      s.asset = ethers.getAddress(asset);
      provider = null;
      const p = await getProvider(s);
      const c = new ethers.Contract(s.asset, ERC20_ABI, p);
      try {
        s.decimals = Number(await c.decimals());
        s.assetSymbol = await c.symbol();
      } catch {
        return fail(t('eTokenRead', { chain: chain.name }));
      }
    }
    const w = ethers.Wallet.createRandom(); // 全新随机私钥，仅用于本次
    if (w.address === dest) return fail(t('eDestOdd'));
    s.privateKey = w.privateKey;
    s.address = w.address;
    await archiveActive();
    active = s;
    await saveActive(); // 先落盘私钥，再把地址展示给用户
    showSession();
  } catch (e) {
    fail(shortErr(e));
  } finally {
    btn.disabled = false;
  }
}

// ---------- Gas 钱包配置 ----------
function renderGas() {
  $('gasEmpty').hidden = !!gasWallet;
  $('gasSet').hidden = !gasWallet;
  $('gasError').hidden = true;
  $('gasPk').value = '';
  $('gasPkShow').hidden = true;
  $('gasPkShow').textContent = '';
  $('revealGas').textContent = t('showKey');
  $('gasBal').textContent = t('balanceNone');
  if (gasWallet) {
    $('gasAddr').textContent = gasWallet.address;
    refreshGasBalance();
  }
}

async function refreshGasBalance() {
  if (!gasWallet) return;
  const ctx = active || { chainId: Number($('chain').value), rpc: $('rpc').value.trim() };
  const chain = chainById(ctx.chainId);
  const el = $('gasBal');
  el.textContent = t('balanceLoading', { chain: chain.name });
  try {
    const p = await getProvider(ctx);
    const bal = await p.getBalance(gasWallet.address);
    el.textContent = t('balanceValue', { chain: chain.name, amount: fmt(bal, 18), symbol: chain.symbol }) +
      (bal === 0n ? t('balanceEmpty') : '');
  } catch (e) {
    el.textContent = t('balanceFailed', { chain: chain.name, err: shortErr(e) });
  }
}

async function setGasWallet(w) {
  gasWallet = w ? { privateKey: w.privateKey, address: w.address } : null;
  await persist();
  renderGas();
  if (active) $('gasMode').textContent = gasModeText(active); // 绑定/删除后立即反映在会话页
}

async function onSaveGas() {
  const err = $('gasError');
  let pk = $('gasPk').value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = '0x' + pk;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('bad');
    await setGasWallet(new ethers.Wallet(pk));
  } catch {
    err.textContent = t('ePk');
    err.hidden = false;
  }
}

async function onReset() {
  if (active && active.phase !== 'done' &&
      !confirm(t('cReset'))) return;
  stopLoop();
  await archiveActive();
  showSetup();
}

async function init() {
  const pref = await store.get('lang');
  if (pref === 'zh' || pref === 'en') LANG = pref;
  applyI18n();
  for (const c of CHAINS) $('chain').add(new Option(`${c.name} (${c.symbol})`, c.id));
  fillAssets();
  $('lang').onclick = async () => {
    LANG = LANG === 'zh' ? 'en' : 'zh';
    await store.set('lang', LANG);
    applyI18n();
    // 重新渲染动态文案，保留表单里已选的内容
    const asset = $('asset').value;
    fillAssets();
    $('asset').value = asset;
    $('customTokenRow').hidden = asset !== 'custom';
    renderGas();
    renderHistory();
    renderSecurity();
    if (active) {
      const chain = chainById(active.chainId);
      $('withdrawHint').textContent = t('withdrawHint', { net: chain.name });
      $('assetName').textContent = active.assetSymbol + (active.asset === 'native' ? t('nativeSuffix') : ' (' + active.asset + ')');
      $('gasMode').textContent = gasModeText(active);
      $('reveal').textContent = t($('pk').hidden ? 'showKey' : 'hideKey');
      renderTxs(active);
      renderPhase(active);
    }
    refreshFee();
  };
  $('chain').onchange = () => { fillAssets(); refreshGasBalance(); refreshFee(); };
  $('refreshFee').onclick = refreshFee;
  $('rpc').onchange = refreshFee;
  $('saveGas').onclick = onSaveGas;
  $('genGas').onclick = () => setGasWallet(ethers.Wallet.createRandom());
  $('refreshGas').onclick = refreshGasBalance;
  $('copyGas').onclick = async () => {
    await navigator.clipboard.writeText(gasWallet.address);
    $('copyGas').textContent = t('copied');
    setTimeout(() => { $('copyGas').textContent = t('copy'); }, 1500);
  };
  $('revealGas').onclick = async () => {
    const el = $('gasPkShow');
    if (el.hidden && !(await reauth())) return;
    el.hidden = !el.hidden;
    el.textContent = el.hidden ? '' : gasWallet.privateKey;
    $('revealGas').textContent = t(el.hidden ? 'showKey' : 'hideKey');
  };
  $('removeGas').onclick = async () => {
    if (!confirm(t('cRemoveGas'))) return;
    await setGasWallet(null);
  };
  $('asset').onchange = () => { $('customTokenRow').hidden = $('asset').value !== 'custom'; refreshFee(); };
  $('start').onclick = onStart;
  $('reset').onclick = onReset;
  $('copy').onclick = async () => {
    await navigator.clipboard.writeText(active.address);
    $('copy').textContent = t('copied');
    setTimeout(() => { $('copy').textContent = t('copy'); }, 1500);
  };
  $('reveal').onclick = async () => {
    const pk = $('pk');
    if (pk.hidden && !(await reauth())) return;
    pk.hidden = !pk.hidden;
    pk.textContent = pk.hidden ? '' : active.privateKey;
    $('reveal').textContent = t(pk.hidden ? 'showKey' : 'hideKey');
  };
  $('clearHistory').onclick = async () => {
    if (!confirm(t('cClear'))) return;
    history = [];
    await saveHistory();
    renderHistory();
  };

  $('refreshHistory').onclick = refreshHistoryBalances;
  bindSecurity();

  vault.meta = (await store.get('vaultMeta')) || null;
  if (vault.enabled) {
    showLock();
  } else {
    gasWallet = (await store.get('gasWallet')) || null;
    history = (await store.get('history')) || [];
    active = (await store.get('active')) || null;
    await startApp();
  }
}

// 数据就绪（未加密，或已解锁）后进入主界面
async function startApp() {
  $('lock').hidden = true;
  $('appBody').hidden = false;
  // 重启程序：上次已完成则直接开始新一轮；未完成的会话继续监听，避免资金滞留。
  if (active && active.phase === 'done') await archiveActive();
  if (active) showSession(); else showSetup();
  renderGas();
  renderSecurity();
}

// ---------- 私钥加密（见 vault.js） ----------
const PLAIN_KEYS = ['active', 'history', 'gasWallet'];

function showLock() {
  $('appBody').hidden = true;
  $('lock').hidden = false;
  $('lockPasskey').hidden = !vault.meta.passkey;
  $('lockPwRow').hidden = !vault.meta.password;
  $('lockError').hidden = true;
}

async function unlock(method) {
  const err = $('lockError');
  err.hidden = true;
  try {
    await vaultUnlock(method, $('lockPw').value);
    const data = await vaultOpen(await store.get('vaultData'));
    active = data.active || null;
    history = data.history || [];
    gasWallet = data.gasWallet || null;
    $('lockPw').value = '';
    for (const k of PLAIN_KEYS) await store.remove(k); // 清掉可能残留的明文
    await startApp();
  } catch (e) {
    err.textContent = e.code === 'BAD_SECRET' ? t('eLockBad')
      : e.code === 'PRF_UNSUPPORTED' ? t('eSecNoPrf') : t('eLockFailed', { err: shortErr(e) });
    err.hidden = false;
  }
}

function renderSecurity() {
  const m = vault.meta;
  const names = [];
  if (m && m.passkey) names.push(t('secMPasskey'));
  if (m && m.password) names.push(t('secMPassword'));
  $('secStatus').textContent = m ? t('secOn', { methods: names.join(' + ') }) : t('secOff');
  $('secPasskey').textContent = t(m ? 'secAddPasskey' : 'secUsePasskey');
  $('secPwToggle').textContent = t(m ? 'secAddPassword' : 'secUsePassword');
  $('secPasskey').hidden = !!(m && m.passkey);
  $('secPwToggle').hidden = !!(m && m.password);
  $('secDisable').hidden = !m;
  if ($('secPwToggle').hidden) $('secPwForm').hidden = true;
}

// 开启加密，或在已开启时再添加一种解锁方式
async function secureWith(method, password) {
  const err = $('secError');
  err.hidden = true;
  try {
    if (method === 'passkey' && !vaultPasskeySupported()) throw Object.assign(new Error('no passkey'), { code: 'NO_PASSKEY' });
    if (vault.enabled) {
      await store.set('vaultMeta', await vaultAddMethod(method, password));
    } else {
      const meta = await vaultCreate(method, password); // 此后 persist() 写的是密文
      await persist();
      await store.set('vaultMeta', meta);
      for (const k of PLAIN_KEYS) await store.remove(k); // 密文和 meta 都落盘后再删明文
    }
    $('secPw1').value = '';
    $('secPw2').value = '';
    $('secPwForm').hidden = true;
  } catch (e) {
    if (!(await store.get('vaultMeta'))) vaultForget(); // 开启到一半失败：保持未加密状态
    err.textContent = e.code === 'NO_PASSKEY' ? t('eSecNoPasskey')
      : e.code === 'PRF_UNSUPPORTED' ? t('eSecNoPrf') : t('eSecFailed', { err: shortErr(e) });
    err.hidden = false;
  }
  renderSecurity();
}

// 敏感操作前再验证一次 Passkey 或密码。未开启加密时没有可验证的凭据，直接放行。
// 返回 true 表示验证通过，false 表示用户取消。
function reauth() {
  if (!vault.enabled) return Promise.resolve(true);
  const dlg = $('auth');
  const err = $('authError');
  $('authPasskey').hidden = !vault.meta.passkey;
  $('authPwRow').hidden = !vault.meta.password;
  $('authPw').value = '';
  err.hidden = true;
  return new Promise((resolve) => {
    const finish = (ok) => {
      $('authPw').value = '';
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(ok);
    };
    const attempt = async (method) => {
      err.hidden = true;
      try {
        await vaultVerify(method, $('authPw').value);
        finish(true);
      } catch (e) {
        err.textContent = e.code === 'BAD_SECRET' ? t('eLockBad') : t('eLockFailed', { err: shortErr(e) });
        err.hidden = false;
      }
    };
    $('authPasskey').onclick = () => attempt('passkey');
    $('authPwBtn').onclick = () => attempt('password');
    $('authPw').onkeydown = (e) => { if (e.key === 'Enter') attempt('password'); };
    $('authCancel').onclick = () => finish(false);
    dlg.onclose = () => resolve(false); // 按 Esc 关闭
    dlg.showModal();
  });
}

function bindSecurity() {
  $('lockPasskey').onclick = () => unlock('passkey');
  $('lockPwBtn').onclick = () => unlock('password');
  $('lockPw').onkeydown = (e) => { if (e.key === 'Enter') unlock('password'); };
  $('secPasskey').onclick = () => secureWith('passkey');
  $('secPwToggle').onclick = () => { $('secPwForm').hidden = !$('secPwForm').hidden; $('secError').hidden = true; };
  $('secPwSave').onclick = () => {
    const err = $('secError');
    const p1 = $('secPw1').value;
    if (p1.length < 8) { err.textContent = t('eSecShort'); err.hidden = false; return; }
    if (p1 !== $('secPw2').value) { err.textContent = t('eSecMismatch'); err.hidden = false; return; }
    secureWith('password', p1);
  };
  $('secDisable').onclick = async () => {
    if (!confirm(t('cSecDisable'))) return;
    if (!(await reauth())) return;
    vaultForget();
    await persist(); // 先写回明文
    await store.remove('vaultMeta');
    await store.remove('vaultData');
    renderSecurity();
  };
}

init();
