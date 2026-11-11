'use strict';
// Independent JavaScript pairing verifier using the deployed Verifier.sol constants.
const BN128 = require('snarkjs/src/bn128');
const isValid = require('snarkjs/src/verifier_groth');
const constants = require('../fixtures/tornado-verifying-key.json');
let key;

function verificationKey() {
  if (key) return key;
  const bn128 = new BN128();
  const g1 = (coordinates) => [...coordinates.map(BigInt), 1n];
  const g2 = (coordinates) => [[BigInt(coordinates[1]), BigInt(coordinates[0])],
    [BigInt(coordinates[3]), BigInt(coordinates[2])], [1n, 0n]];
  key = {
    nPublic: 6,
    vk_alfabeta_12: bn128.pairing(g1(constants.alfa1), g2(constants.beta2)),
    vk_gamma_2: g2(constants.gamma2),
    vk_delta_2: g2(constants.delta2),
    IC: constants.IC.map(g1),
  };
  return key;
}

function verify(proofHex, publicInputs) {
  if (!/^0x[0-9a-fA-F]{512}$/.test(proofHex) || publicInputs.length !== 6) return false;
  const word = Array.from({ length: 8 }, (_, index) => BigInt('0x' + proofHex.slice(2 + index * 64, 66 + index * 64)));
  const proof = {
    pi_a: [word[0], word[1], 1n],
    pi_b: [[word[3], word[2]], [word[5], word[4]], [1n, 0n]],
    pi_c: [word[6], word[7], 1n],
  };
  return isValid(verificationKey(), proof, publicInputs.map(BigInt));
}

module.exports = { verify };
