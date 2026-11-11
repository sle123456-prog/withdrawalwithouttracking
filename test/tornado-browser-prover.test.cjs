'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { Worker: NodeWorker } = require('node:worker_threads');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { verify } = require('./helpers/tornado-verifier.cjs');

const root = path.join(__dirname, '..');

test('packaged MV3 prover produces a valid proof with static templates/workers and string code generation disabled', { timeout: 120000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tornado-worker-test-'));
  const bridge = path.join(temporary, 'worker-bridge.cjs');
  const workers = new Set();
  let api;
  try {
    // Run the exact packaged browser worker file behind a Node transport. The bridge
    // itself is a fixed local file; neither the bundle nor worker receives JS strings.
    await fs.writeFile(bridge,
      "const { parentPort, workerData } = require('node:worker_threads');\n" +
      'globalThis.self = { postMessage: (value, transfers) => parentPort.postMessage(value, transfers), close: () => process.exit() };\n' +
      'parentPort.on("message", value => globalThis.self.onmessage({ data: value }));\n' +
      'require(workerData.script);\n');
    class BrowserWorker {
      constructor(url) {
        const file = fileURLToPath(url);
        assert.equal(path.dirname(file), path.join(root, 'extension/vendor/tornado'));
        assert.match(path.basename(file), /^(?:groth16|ffjavascript)-worker\.js$/);
        this.worker = new NodeWorker(bridge, { workerData: { script: file } });
        workers.add(this.worker);
        this.worker.on('message', (data) => this.onmessage?.({ data }));
      }
      postMessage(value, transfers) { this.worker.postMessage(value, transfers); }
      async terminate() {
        await this.worker.terminate();
        workers.delete(this.worker);
      }
    }
    const context = vm.createContext({
      console, atob, btoa,
      crypto: globalThis.crypto,
      window: { crypto: globalThis.crypto },
      navigator: { hardwareConcurrency: 2 },
      document: { baseURI: pathToFileURL(path.join(root, 'extension/app.html')).href },
      URL, Worker: BrowserWorker, WebAssembly, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, Uint8Array, ArrayBuffer, DataView,
      fetch: async (url) => {
        assert.equal(new URL(url).protocol, 'file:', 'Prover attempted a network request');
        const file = fileURLToPath(url);
        assert.equal(path.dirname(file), path.join(root, 'extension/vendor/tornado'));
        const bytes = await fs.readFile(file);
        return { ok: true,
          json: async () => JSON.parse(bytes.toString('utf8')),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      },
    }, { codeGeneration: { strings: false, wasm: true } });
    const bundle = await fs.readFile(path.join(root, 'extension/vendor/tornado/crypto.js'), 'utf8');
    try { vm.runInContext(bundle, context, { displayErrors: false }); } catch (error) {
      throw new Error('Packaged browser prover initialization failed: ' + error.message);
    }
    assert.throws(() => vm.runInContext('eval("1 + 1")', context), /Code generation from strings disallowed/);
    api = context.TornadoCrypto;
    assert.equal(await api.ready(), true);
    const note = await api.createNote({ currency: 'eth', amount: '0.1', chainId: 1 });
    const result = await api.prove({
      note: note.note, leaves: [note.commitment],
      recipient: '0x1111111111111111111111111111111111111111',
      relayer: '0x2222222222222222222222222222222222222222',
      fee: '100000000000000', refund: '0',
    });
    assert.equal(result.proof.length, 514);
    assert.equal(result.nullifierHash, note.nullifierHash);
    assert.equal(verify(result.proof, Array.from(result.args)), true,
      'Static browser bundle proof failed against the deployed Classic verifier key');
    const wrongRecipient = Array.from(result.args, BigInt);
    wrongRecipient[2] += 1n;
    assert.equal(verify(result.proof, wrongRecipient), false);
    const wrongFee = Array.from(result.args, BigInt);
    wrongFee[4] += 1n;
    assert.equal(verify(result.proof, wrongFee), false);
  } finally {
    // Cover initialization/proof failures too; no worker or temporary file survives a test.
    if (api) await api.dispose().catch(() => {});
    await Promise.all([...workers].map((worker) => worker.terminate()));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
