/* global ethers */
'use strict';
// Bitget Wallet 免 Gas 转账（toc_agent 网关：getTransferDataV4 + send）。
// 中转地址无需持有原生币：手续费由 Bitget 的中继从转账的 USDT/USDC 里扣除。
// 接口与签名方式参照 Bitget 官方公开的 bitget-wallet-skill（docs/transfer.md）。
const BGW = {
  base: 'https://copenapi.bgwapi.io',
  // 服务端响应签名公钥（RSA-PKCS1v15-SHA256），用于校验返回的待签名数据未被篡改
  pem: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAk18NCL9CoiE8OQ588ehJ' +
    'hVoCenARvVymahlH3Sw8URZATuZw4k8ZKC8Sf7Zu9i9l3L3K5X4m2I20UENkOBzP' +
    'YGCRHk3Dy8SQk/e7ucj/hXJH07yNDJuv1t1nWXRhvwpG8rdW03KpDhJy4pgcAMXl' +
    'JYnJYqhfj7HW/urMD0KXw7dLNKyWKBoaGzKkoRvvxTSDHk35cjETcYg6H+bEm+Px' +
    'a+GnIJkuN5U2/LfZ4WxgNiIdE2zacHLcFoFsM14jTQdcvPid+6ilY8SQCA3GWc72' +
    'n1RudWoTj1ThEUVNWXgcwxLFIdiLCNH1YF7qINdRrjOOCCBBBpr6jdANdI2e4Dcy' +
    'DQIDAQAB',
  chains: { 1: 'eth', 56: 'bnb', 8453: 'base', 42161: 'arbitrum', 137: 'matic' },
  // 支持免 Gas 的代币（USDT / USDC），小写
  tokens: {
    1: ['0xdac17f958d2ee523a2206206994597c13d831ec7', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
    56: ['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'],
    8453: ['0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
    42161: ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
    137: ['0xc2132d05d31c914a87c6611c10748aeb04b58e8f', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'],
  },
};

function bgwEligible(chainId, asset) {
  const list = BGW.tokens[chainId];
  return !!list && typeof asset === 'string' && list.includes(asset.toLowerCase());
}

let bgwKeyPromise = null;
function bgwKey() {
  if (!bgwKeyPromise) {
    const der = Uint8Array.from(atob(BGW.pem), (c) => c.charCodeAt(0));
    bgwKeyPromise = crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  return bgwKeyPromise;
}

async function bgwVerify(sigHex, bytes) {
  try {
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await bgwKey(), ethers.getBytes(sigHex), bytes);
  } catch {
    return false;
  }
}

// verify=true 时校验三个 security-* 响应头，任何一个缺失或验签失败都拒绝继续。
async function bgwRequest(path, body, verify) {
  const bodyStr = JSON.stringify(body);
  const ts = String(Date.now());
  const sign = ethers.sha256(ethers.toUtf8Bytes('POST' + path + bodyStr + ts));
  const resp = await fetch(BGW.base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', channel: 'toc_agent', brand: 'toc_agent',
      clientversion: '10.0.0', language: 'en', token: 'toc_agent', 'X-SIGN': sign, 'X-TIMESTAMP': ts,
    },
    body: bodyStr,
  });
  if (!resp.ok) throw new Error('Bitget 接口返回 HTTP ' + resp.status);
  const raw = new Uint8Array(await resp.arrayBuffer());
  const json = JSON.parse(new TextDecoder().decode(raw));
  if (verify && json.status === 0) {
    const a = resp.headers.get('security-check');
    const b = resp.headers.get('security-request-check');
    const c = resp.headers.get('security-double-check');
    const enc = new TextEncoder();
    const ok = a && b && c &&
      (await bgwVerify(a, raw)) &&
      (await bgwVerify(b, enc.encode(bodyStr))) &&
      (await bgwVerify(c, enc.encode(a + b)));
    if (!ok) throw new Error('Bitget 响应签名校验失败，已中止（不会签名）');
  }
  return json;
}

function bgwErr(json) {
  const d = json && json.data;
  return (json && json.msg) || (typeof d === 'string' ? d : '') || '状态码 ' + (json && json.status);
}

// 只保留 primaryType 可达的类型，供 ethers 的 EIP-712 编码器使用
function bgwTypes(types, primary) {
  const out = {};
  const walk = (name) => {
    if (out[name] || !types[name]) return;
    out[name] = types[name];
    for (const f of types[name]) walk(f.type.replace(/\[\d*\]$/, ''));
  };
  walk(primary);
  return out;
}

async function bgwSign(data, wallet, chainId) {
  if (Array.isArray(data.signDataV2) && data.signDataV2.length) {
    const results = [];
    for (const item of data.signDataV2) {
      const typed = item.data || {};
      const domain = { ...(typed.domain || {}) };
      if (domain.chainId !== undefined) {
        domain.chainId = Number(BigInt(domain.chainId));
        if (domain.chainId !== chainId) throw new Error('Bitget 返回的签名数据链 ID 不符，已中止');
      }
      const all = { ...(typed.types || {}) };
      delete all.EIP712Domain;
      let types = all;
      if (typed.primaryType) {
        if (!all[typed.primaryType]) throw new Error('Bitget 返回的 EIP-712 数据不完整，已中止');
        types = bgwTypes(all, typed.primaryType);
      }
      // 未给 primaryType 且无法唯一推断时 ethers 会抛错 —— 宁可中止也不乱签
      const signature = await wallet.signTypedData(domain, types, typed.message || {});
      results.push({ domain, message: typed.message || {}, signature });
    }
    return JSON.stringify(results);
  }
  const sd = data.signData;
  if (sd && sd.sign_type === 'sign_7702_msgs' && Array.isArray(sd.data) && sd.data.length) {
    for (const msg of sd.data) {
      if (!ethers.isHexString(msg.hash, 32)) throw new Error('Bitget 返回的签名哈希格式异常，已中止');
      msg.sig = wallet.signingKey.sign(msg.hash).serialized;
    }
    return JSON.stringify(sd.data);
  }
  throw new Error('无法识别 Bitget 返回的免 Gas 签名格式，已中止');
}

// 免 Gas 把 amount（十进制字符串）代币从中转地址转给 s.dest。
// 成功返回 { txid, amount, fee }；本次匹配不到免 Gas 方案返回 { unavailable: 原因 }。
async function bgwTransfer(s, wallet, amount) {
  const chain = BGW.chains[s.chainId];
  const req = { chain, contract: s.asset, from: s.address, to: s.dest, amount };
  const resp = await bgwRequest('/user/wallet/getTransferDataV4', req, true);
  if (resp.status !== 0) return { unavailable: bgwErr(resp) };
  const data = resp.data || {};
  const ga = data.gasAccount;
  if (!ga || ga.selected !== true) return { unavailable: '该链/代币/金额当前未匹配到免 Gas 方案' };
  if (data.fee && data.fee.estimateRevert) {
    return { unavailable: '预估交易会失败：' + (data.fee.estimateRevertReason || '未知原因') };
  }
  if (data.hasPendingTransactionAndOverwriteNonce) return { unavailable: '该地址有未确认的交易，稍后重试' };
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
  if ((data.from && !same(data.from, s.address)) || (data.receiver && !same(data.receiver, s.dest)) ||
      (data.contract && !same(data.contract, s.asset))) {
    throw new Error('Bitget 返回的转账信息与请求不一致，已中止');
  }
  const sid = (ga.pay && ga.pay.sid) || ga.sid;
  if (sid === 'transfer_no_gas_trx') throw new Error('不支持的免 Gas 方案：' + sid);

  const sig = await bgwSign(data, wallet, s.chainId);
  const sent = await bgwRequest('/user/wallet/send', {
    chain: data.chain || chain, contract: data.contract || s.asset, from: data.from || s.address,
    to: s.dest, amount: data.amount || amount, sig, gasAccount: ga,
  }, false);
  if (sent.status !== 0) return { unavailable: '提交失败：' + bgwErr(sent) };
  const txid = sent.data && sent.data.txid;
  if (!txid) throw new Error('Bitget 已受理但没有返回交易哈希');
  const pay = (ga.pay && ga.pay.payToken) || {};
  return { txid, amount: data.amount || amount, fee: pay.amount ? pay.amount + ' ' + (pay.symbol || '') : '' };
}
