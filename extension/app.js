/* global ethers, qrcode, CHAINS, chrome, t, applyI18n, LANG:writable */
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
};

let active = null; // 当前会话
let gasWallet = null; // { privateKey, address }，代付 gas 的钱包
let history = []; // 已重置的旧会话（保留私钥以便取回资金）
let timer = null;
let busy = false;
let provider = null;
let providerKey = '';

const saveActive = () => store.set('active', active);
const saveHistory = () => store.set('history', history);

// ---------- 链访问 ----------
async function getProvider(s) {
  const chain = chainById(s.chainId);
  const urls = s.rpc ? [s.rpc] : chain.rpcs;
  const key = s.chainId + '|' + urls.join(',');
  if (provider && providerKey === key) return provider;
  let lastErr;
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
      const net = await p.getNetwork();
      if (net.chainId !== BigInt(chain.id)) {
        p.destroy();
        throw new Error(t('eChainId', { got: String(net.chainId), chain: chain.name, id: chain.id }));
      }
      provider = p;
      providerKey = key;
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
        try { // 剩余的 gas：垫付过则退回 Gas 钱包，否则一并转给 B
          const back = s.gasFunded && gasWallet;
          const r2 = await sweepNative(s, p, wallet, back ? gasWallet.address : s.dest);
          if (r2) addTx(s, r2.hash, back ? 'txLeftGas' : 'txLeftB', { amount: fmt(r2.value, 18), symbol: chain.symbol });
        } catch (e) { console.warn('sweep leftover failed', e); }
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
  $('gasMode').textContent = t(s.asset === 'native' ? 'gasModeNative' : 'gasModeWallet');
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
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = t('restore');
    btn.onclick = () => restore(h.id);
    li.append(code, meta, btn);
    ul.append(li);
  });
}

async function archiveActive() {
  if (!active) return;
  history.push(active);
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
      if (!gasWallet) return fail(t('eNeedGasWallet'));
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
  await store.set('gasWallet', gasWallet);
  renderGas();
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
    if (active) {
      const chain = chainById(active.chainId);
      $('withdrawHint').textContent = t('withdrawHint', { net: chain.name });
      $('assetName').textContent = active.assetSymbol + (active.asset === 'native' ? t('nativeSuffix') : ' (' + active.asset + ')');
      $('gasMode').textContent = t(active.asset === 'native' ? 'gasModeNative' : 'gasModeWallet');
      $('reveal').textContent = t($('pk').hidden ? 'showKey' : 'hideKey');
      renderTxs(active);
      renderPhase(active);
    }
  };
  $('chain').onchange = () => { fillAssets(); refreshGasBalance(); };
  $('saveGas').onclick = onSaveGas;
  $('genGas').onclick = () => setGasWallet(ethers.Wallet.createRandom());
  $('refreshGas').onclick = refreshGasBalance;
  $('copyGas').onclick = async () => {
    await navigator.clipboard.writeText(gasWallet.address);
    $('copyGas').textContent = t('copied');
    setTimeout(() => { $('copyGas').textContent = t('copy'); }, 1500);
  };
  $('revealGas').onclick = () => {
    const el = $('gasPkShow');
    el.hidden = !el.hidden;
    el.textContent = el.hidden ? '' : gasWallet.privateKey;
    $('revealGas').textContent = t(el.hidden ? 'showKey' : 'hideKey');
  };
  $('removeGas').onclick = async () => {
    if (!confirm(t('cRemoveGas'))) return;
    await setGasWallet(null);
  };
  $('asset').onchange = () => { $('customTokenRow').hidden = $('asset').value !== 'custom'; };
  $('start').onclick = onStart;
  $('reset').onclick = onReset;
  $('copy').onclick = async () => {
    await navigator.clipboard.writeText(active.address);
    $('copy').textContent = t('copied');
    setTimeout(() => { $('copy').textContent = t('copy'); }, 1500);
  };
  $('reveal').onclick = () => {
    const pk = $('pk');
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

  gasWallet = (await store.get('gasWallet')) || null;
  history = (await store.get('history')) || [];
  active = (await store.get('active')) || null;
  // 重启程序：上次已完成则直接开始新一轮；未完成的会话继续监听，避免资金滞留。
  if (active && active.phase === 'done') await archiveActive();
  if (active) showSession(); else showSetup();
  renderGas();
}

init();
