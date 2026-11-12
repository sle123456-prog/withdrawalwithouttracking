'use strict';
// 私钥加密存储。
// 所有含私钥的数据（当前会话、历史地址、Gas 钱包）序列化后用一个随机主密钥做 AES-256-GCM 加密。
// 主密钥本身不落盘，只保存它被“解锁方式”包裹后的密文，解锁方式可以是：
//   - Passkey：用 WebAuthn PRF 扩展从通行密钥派生出包裹密钥（需要验证指纹/面容/PIN）
//   - 密码：PBKDF2-SHA256 派生包裹密钥
// 页面打开后解锁一次，主密钥只留在内存里；关闭或刷新页面即重新上锁。
const VAULT_PBKDF2_ITER = 600000;

const vault = {
  meta: null, // { v, passkey?: { credId, salt, box }, password?: { salt, iter, box } }
  master: null, // Uint8Array(32)，仅在解锁后存在
  key: null, // 由 master 导入的 AES-GCM CryptoKey
  get enabled() { return !!this.meta; },
  get unlocked() { return !!this.key; },
};

function vb64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const vunb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const vrand = (n) => crypto.getRandomValues(new Uint8Array(n));
const vAes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function vSeal(key, bytes) {
  const iv = vrand(12);
  return { iv: vb64(iv), ct: vb64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
}
async function vOpen(key, box) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vunb64(box.iv) }, key, vunb64(box.ct)));
}

async function vPasswordKek(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function vPrfKek(prfOutput) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('relay-wallet-vault-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function vaultPasskeySupported() {
  return typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

// 新建一个通行密钥，返回它的 credential id。认证器不支持 PRF 时抛出 code='PRF_UNSUPPORTED'。
async function vPasskeyCreate() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'One-Time Relay Wallet' },
      user: { id: vrand(16), name: 'relay-wallet', displayName: 'One-Time Relay Wallet' },
      challenge: vrand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: {} },
    },
  });
  const prf = cred.getClientExtensionResults().prf;
  if (!prf || !prf.enabled) throw Object.assign(new Error('PRF unsupported'), { code: 'PRF_UNSUPPORTED' });
  return vb64(cred.rawId);
}

// 用通行密钥验证并取得 PRF 输出（32 字节）
async function vPasskeyPrf(credId, salt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: vrand(32),
      allowCredentials: [{ type: 'public-key', id: vunb64(credId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: vunb64(salt) } } },
    },
  });
  const prf = assertion.getClientExtensionResults().prf;
  if (!prf || !prf.results || !prf.results.first) {
    throw Object.assign(new Error('PRF unsupported'), { code: 'PRF_UNSUPPORTED' });
  }
  return new Uint8Array(prf.results.first);
}

async function vWrapWithPasskey(master) {
  const credId = await vPasskeyCreate();
  const salt = vb64(vrand(32));
  const kek = await vPrfKek(await vPasskeyPrf(credId, salt));
  return { credId, salt, box: await vSeal(kek, master) };
}

async function vWrapWithPassword(master, password) {
  const salt = vrand(16);
  const kek = await vPasswordKek(password, salt, VAULT_PBKDF2_ITER);
  return { salt: vb64(salt), iter: VAULT_PBKDF2_ITER, box: await vSeal(kek, master) };
}

async function vSetMaster(master) {
  vault.master = master;
  vault.key = await vAes(master);
}

// 生成主密钥并用指定方式包裹。method: 'passkey' | 'password'。返回新的 meta（调用方负责落盘）。
async function vaultCreate(method, password) {
  const master = vrand(32);
  const meta = { v: 1 };
  if (method === 'passkey') meta.passkey = await vWrapWithPasskey(master);
  else meta.password = await vWrapWithPassword(master, password);
  await vSetMaster(master);
  vault.meta = meta;
  return meta;
}

// 已解锁时再添加一种解锁方式
async function vaultAddMethod(method, password) {
  if (!vault.unlocked) throw new Error('locked');
  const meta = { ...vault.meta };
  if (method === 'passkey') meta.passkey = await vWrapWithPasskey(vault.master);
  else meta.password = await vWrapWithPassword(vault.master, password);
  vault.meta = meta;
  return meta;
}

// 解锁。密码错误时 AES-GCM 校验失败，抛出 code='BAD_SECRET'。
async function vaultUnlock(method, password) {
  const m = vault.meta[method];
  let kek;
  if (method === 'passkey') kek = await vPrfKek(await vPasskeyPrf(m.credId, m.salt));
  else kek = await vPasswordKek(password, vunb64(m.salt), m.iter);
  let master;
  try {
    master = await vOpen(kek, m.box);
  } catch {
    throw Object.assign(new Error('bad secret'), { code: 'BAD_SECRET' });
  }
  await vSetMaster(master);
}

async function vaultSeal(obj) {
  return vSeal(vault.key, new TextEncoder().encode(JSON.stringify(obj)));
}
async function vaultOpen(box) {
  return JSON.parse(new TextDecoder().decode(await vOpen(vault.key, box)));
}

function vaultForget() {
  vault.meta = null;
  vault.master = null;
  vault.key = null;
}
