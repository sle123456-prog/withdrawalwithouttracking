'use strict';

// Compatible with the deployed Tornado Cash Classic withdrawal circuit.
// The browser build precompiles the legacy witness templates; it never evaluates code from JSON.
const { Buffer } = require('buffer');
const { buildPedersenHash, buildMimcSponge } = require('circomlibjs');
const { MerkleTree } = require('fixed-merkle-tree');
const buildGroth16 = require('websnark/src/groth16');
const { genWitnessAndProve, toSolidityInput } = require('websnark/src/utils');

const TREE_HEIGHT = 20;
const ZERO_ELEMENT = '21663839004416932945382355908790599225266501822907911457504978515578255421292';
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
let hashPromise;
let assetsPromise;
let proverPromise;
let proving = false;

function fixedHex(value, bytes = 32) {
  const number = BigInt(value);
  if (number < 0n || number >= (1n << BigInt(bytes * 8))) throw new Error('Value outside fixed-width integer range');
  return '0x' + number.toString(16).padStart(bytes * 2, '0');
}

function address(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Invalid proof address');
  return BigInt(value);
}

async function hashes() {
  if (!hashPromise) {
    hashPromise = Promise.all([buildPedersenHash(), buildMimcSponge()]).catch((error) => {
      hashPromise = null;
      throw error;
    });
  }
  return hashPromise;
}

function readLittleEndian(bytes) {
  let number = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) number = (number << 8n) + BigInt(bytes[i]);
  return number;
}

async function parseNote(note) {
  if (typeof note !== 'string') throw new Error('Invalid Tornado note');
  const match = /^tornado-([a-z]+)-(\d+(?:\.\d+)?)-(\d+)-0x([0-9a-fA-F]{124})$/.exec(note);
  if (!match || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= 0 || Number(match[2]) <= 0) {
    throw new Error('Invalid Tornado note');
  }
  const [, currency, amount, net, secretHex] = match;
  const [pedersen] = await hashes();
  const bytes = Buffer.from(secretHex, 'hex');
  const hash = (input) => {
    const point = pedersen.babyJub.unpackPoint(pedersen.hash(input));
    if (!point) throw new Error('Invalid Pedersen hash point');
    return BigInt(pedersen.babyJub.F.toString(point[0]));
  };
  return {
    note, currency, amount, chainId: Number(net),
    secret: readLittleEndian(bytes.subarray(31)),
    nullifier: readLittleEndian(bytes.subarray(0, 31)),
    commitment: fixedHex(hash(bytes)),
    nullifierHash: fixedHex(hash(bytes.subarray(0, 31))),
  };
}

async function createNote({ currency, amount, chainId }) {
  if (!/^[a-z]+$/.test(currency) || !/^\d+(?:\.\d+)?$/.test(String(amount)) ||
      Number(amount) <= 0 || !Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0) {
    throw new Error('Invalid note pool parameters');
  }
  const random = new Uint8Array(62);
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('A cryptographically secure random generator is required');
  }
  globalThis.crypto.getRandomValues(random);
  const note = `tornado-${currency}-${amount}-${chainId}-0x${Buffer.from(random).toString('hex')}`;
  const parsed = await parseNote(note);
  return { note, commitment: parsed.commitment, nullifierHash: parsed.nullifierHash };
}

function localAssetUrl(name) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL('vendor/tornado/' + name);
  }
  if (typeof document !== 'undefined') return new URL('vendor/tornado/' + name, document.baseURI).href;
  throw new Error('Supply local circuit assets when running without a browser');
}

async function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const responses = await Promise.all(['tornado.json', 'tornadoProvingKey.bin'].map(async (name) => {
        const response = await fetch(localAssetUrl(name), { cache: 'force-cache' });
        if (!response.ok) throw new Error('Bundled Tornado circuit asset is unavailable: ' + name);
        return name.endsWith('.json') ? response.json() : response.arrayBuffer();
      }));
      return { circuit: responses[0], provingKey: responses[1] };
    })().catch((error) => { assetsPromise = null; throw error; });
  }
  return assetsPromise;
}

async function getProver() {
  if (!proverPromise) {
    proverPromise = buildGroth16({ wasmInitialMemory: 2000 }).catch((error) => {
      proverPromise = null;
      throw error;
    });
  }
  return proverPromise;
}

async function ready() {
  await Promise.all([hashes(), loadAssets(), getProver()]);
  return true;
}

async function prove({ note, leaves, recipient, relayer = ZERO_ADDRESS, fee = 0, refund = 0, assets }) {
  // Legacy websnark shares a WASM allocation arena and must never run two proofs concurrently.
  if (proving) throw new Error('A Tornado proof is already being generated');
  proving = true;
  try {
    if (!Array.isArray(leaves) || !leaves.length || leaves.length > 2 ** TREE_HEIGHT) {
      throw new Error('A complete, ordered deposit-leaf array is required');
    }
    const parsed = await parseNote(note);
    const [, mimc] = await hashes();
    const normalized = leaves.map((leaf) => {
      const value = BigInt(leaf);
      if (value < 0n || value >= FIELD) throw new Error('Invalid deposit commitment');
      return value.toString();
    });
    const commitment = BigInt(parsed.commitment).toString();
    const index = normalized.indexOf(commitment);
    if (index < 0 || normalized.lastIndexOf(commitment) !== index) {
      throw new Error('The note must occur exactly once in the deposit tree');
    }
    const tree = new MerkleTree(TREE_HEIGHT, normalized, {
      zeroElement: ZERO_ELEMENT,
      hashFunction: (left, right) => mimc.F.toString(mimc.multiHash([BigInt(left), BigInt(right)])),
    });
    const { pathElements, pathIndices } = tree.path(index);
    const input = {
      root: tree.root,
      nullifierHash: BigInt(parsed.nullifierHash).toString(),
      recipient: address(recipient).toString(),
      relayer: address(relayer).toString(),
      fee: BigInt(fee).toString(),
      refund: BigInt(refund).toString(),
      secret: parsed.secret.toString(),
      nullifier: parsed.nullifier.toString(),
      pathElements, pathIndices,
    };
    if (BigInt(input.fee) < 0n || BigInt(input.refund) < 0n ||
        BigInt(input.fee) >= FIELD || BigInt(input.refund) >= FIELD) throw new Error('Invalid withdrawal fee/refund');
    const { circuit, provingKey } = assets || await loadAssets();
    const prover = await getProver();
    const data = await genWitnessAndProve(prover, input, circuit, provingKey);
    const { proof } = toSolidityInput(data);
    return {
      proof,
      args: [fixedHex(input.root), parsed.nullifierHash, fixedHex(input.recipient, 20),
        fixedHex(input.relayer, 20), fixedHex(input.fee), fixedHex(input.refund)],
      root: fixedHex(input.root),
      nullifierHash: parsed.nullifierHash,
    };
  } finally {
    proving = false;
  }
}

async function dispose() {
  if (proving) throw new Error('Cannot stop an active Tornado proof');
  if (proverPromise) {
    const prover = await proverPromise;
    for (const worker of prover.workers) await worker.terminate();
    proverPromise = null;
  }
}

module.exports = { createNote, parseNote, prove, ready, dispose, TREE_HEIGHT, ZERO_ELEMENT };
