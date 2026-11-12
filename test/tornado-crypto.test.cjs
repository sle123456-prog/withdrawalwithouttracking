'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('../crypto/tornado-crypto.cjs');
const key = require('./fixtures/tornado-verifying-key.json');
const BN128 = require('snarkjs/src/bn128');
const isValid = require('snarkjs/src/verifier_groth');
const pools = require('../extension/tornado-pools.js');

const output = path.join(__dirname, '../extension/vendor/tornado');
const recipient = '0x1111111111111111111111111111111111111111';
const relayer = '0x2222222222222222222222222222222222222222';

function verifierKey() {
  const bn128 = new BN128();
  const g1 = (values) => [...values.map(BigInt), 1n];
  // Solidity's EIP-197 encoding is imaginary/real; snarkjs uses real/imaginary.
  const g2 = (values) => [[BigInt(values[1]), BigInt(values[0])],
    [BigInt(values[3]), BigInt(values[2])], [1n, 0n]];
  return {
    nPublic: 6,
    vk_alfabeta_12: bn128.pairing(g1(key.alfa1), g2(key.beta2)),
    vk_gamma_2: g2(key.gamma2),
    vk_delta_2: g2(key.delta2),
    IC: key.IC.map(g1),
  };
}

function unpackProof(hex) {
  const words = Array.from({ length: 8 }, (_, index) => BigInt('0x' + hex.slice(2 + index * 64, 66 + index * 64)));
  return {
    pi_a: [words[0], words[1], 1n],
    pi_b: [[words[3], words[2]], [words[5], words[4]], [1n, 0n]],
    pi_c: [words[6], words[7], 1n],
  };
}

test('deployment allowlist rejects unsupported chain/assets', () => {
  assert.deepEqual(pools.getPools(8453, 'native'), []);
  assert.deepEqual(pools.getPools(1, recipient), []);
  assert.equal(pools.getPools(1, 'native').at(-1).amount, '0.1');
  assert.equal(pools.getPools(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48').length, 2);
});

test('secure notes round-trip and distinct notes have distinct commitments', async () => {
  const first = await crypto.createNote({ currency: 'eth', amount: '0.1', chainId: 1 });
  const second = await crypto.createNote({ currency: 'eth', amount: '0.1', chainId: 1 });
  assert.notEqual(first.note, second.note);
  assert.notEqual(first.commitment, second.commitment);
  const parsed = await crypto.parseNote(first.note);
  assert.equal(parsed.commitment, first.commitment);
  assert.equal(parsed.nullifierHash, first.nullifierHash);
  await assert.rejects(crypto.parseNote(first.note + '00'), /Invalid Tornado note/);
});

test('real Groth16 proof verifies against the deployed Classic verifier key and binds recipient/fee', { timeout: 120000 }, async () => {
  const note = await crypto.createNote({ currency: 'eth', amount: '0.1', chainId: 1 });
  const other = await crypto.createNote({ currency: 'eth', amount: '1', chainId: 1 });
  const bytes = fs.readFileSync(path.join(output, 'tornadoProvingKey.bin'));
  const assets = {
    circuit: JSON.parse(fs.readFileSync(path.join(output, 'tornado.json'), 'utf8')),
    provingKey: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
  try {
    const result = await crypto.prove({ note: note.note, leaves: [other.commitment, note.commitment],
      recipient, relayer, fee: 100000000000000n, refund: 0n, assets });
    assert.equal(result.proof.length, 514);
    assert.equal(result.nullifierHash, note.nullifierHash);
    const verifyingKey = verifierKey();
    const proof = unpackProof(result.proof);
    const inputs = result.args.map(BigInt);
    assert.equal(isValid(verifyingKey, proof, inputs), true, 'Real proof failed the hardcoded deployed verifier key');
    const wrongRecipient = inputs.slice();
    wrongRecipient[2] += 1n;
    assert.equal(isValid(verifyingKey, proof, wrongRecipient), false);
    const wrongFee = inputs.slice();
    wrongFee[4] += 1n;
    assert.equal(isValid(verifyingKey, proof, wrongFee), false);
    await assert.rejects(crypto.prove({ note: note.note, leaves: [other.commitment],
      recipient, relayer, assets }), /must occur exactly once/);
  } finally {
    await crypto.dispose();
  }
});

test('browser prover has no eval or dynamically generated worker and uses packaged assets', () => {
  const bundle = fs.readFileSync(path.join(output, 'crypto.js'), 'utf8');
  // ffjavascript has a polynomial method named eval(); it is ordinary arithmetic,
  // so distinguish a direct JS eval call from method declarations and .eval().
  assert.equal(/(?<![.\w])eval\s*\([^)]*\)(?!\{)/.test(bundle), false);
  assert.equal(/new Function\s*\(/.test(bundle), false);
  assert.equal(/new Blob\s*\(/.test(bundle), false);
  assert.equal(/data:application\/javascript/.test(bundle), false);
  assert.match(bundle, /groth16-worker\.js/);
  assert.equal(fs.existsSync(path.join(output, 'groth16-worker.js')), true);
  assert.equal(fs.existsSync(path.join(output, 'ffjavascript-worker.js')), true);
});
