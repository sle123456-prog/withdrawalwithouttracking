import { readFile, writeFile, mkdir, access, copyFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const output = path.join(root, 'extension/vendor/tornado');
const cache = path.join(root, 'work/tornado-build');
const uiCommit = 'a83fae0772c8da084c0e76b3a756b456f5b9f5bb';
const archives = [
  { name: 'tornado.json', gitBlob: '748a238bf42162cfc58bcfc6a3f545800243f0ce' },
  { name: 'tornadoProvingKey.bin', gitBlob: '509f3abfdb15f173732ca67172e46519f385139c' },
];
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });

function gitBlobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

const provenance = {
  ui: `https://github.com/tornadocash/tornado-classic-ui/tree/${uiCommit}`,
  websnark: 'https://github.com/tornadocash/websnark/tree/4c0af6a8b65aabea3c09f377f63c44e7a58afa6d',
  snarkjs: 'https://github.com/tornadocash/snarkjs/tree/869181cfaf7526fe8972073d31655493a04326d5',
  assets: [],
};

for (const archive of archives) {
  const zipPath = path.join(cache, archive.name + '.zip');
  try { await access(zipPath); } catch {
    // Also accept an archive copied by the developer while preparing an offline build.
    try { await copyFile(path.join(output, archive.name + '.zip'), zipPath); } catch {
      const url = `https://raw.githubusercontent.com/tornadocash/tornado-classic-ui/${uiCommit}/static/${archive.name}.zip`;
      try {
        execFileSync('curl', ['--fail', '--location', '--connect-timeout', '15', '--max-time', '60', url, '--output', zipPath], { stdio: 'inherit' });
      } catch {
        // Some networks cannot reach the raw-file CDN. The public Git API
        // exposes the same hash-pinned bytes as base64, without credentials.
        const api = `https://api.github.com/repos/tornadocash/tornado-classic-ui/git/blobs/${archive.gitBlob}`;
        const response = execFileSync('curl', ['--fail', '--location', '--connect-timeout', '15', '--max-time', '180', api], { maxBuffer: 30 * 1024 * 1024 });
        const blob = JSON.parse(response.toString('utf8'));
        if (blob.encoding !== 'base64' || !blob.content) throw new Error('Missing upstream circuit archive');
        await writeFile(zipPath, Buffer.from(blob.content, 'base64'));
      }
    }
  }
  const zipped = await readFile(zipPath);
  if (gitBlobSha(zipped) !== archive.gitBlob) throw new Error(`Upstream archive integrity check failed: ${archive.name}`);
  const bytes = execFileSync('unzip', ['-p', zipPath, archive.name], { maxBuffer: 100 * 1024 * 1024 });
  await writeFile(path.join(output, archive.name), bytes);
  // Keep download intermediates in the build cache, outside the installable extension.
  await unlink(path.join(output, archive.name + '.zip')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  provenance.assets.push({ file: archive.name, sourceArchiveGitBlob: archive.gitBlob,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}

const circuit = JSON.parse(await readFile(path.join(output, 'tornado.json'), 'utf8'));
const originalCircuit = await readFile(require.resolve('snarkjs/src/circuit'), 'utf8');
const templateTable = Object.entries(circuit.templates).map(([name, fn]) => `${JSON.stringify(name)}: (${fn})`).join(',\n');
const functionTable = Object.entries(circuit.functions).map(([name, fn]) =>
  `${JSON.stringify(name)}: (${fn.func})`).join(',\n');
// Compile the trusted, hash-pinned circuit's witness code at build time. MV3 forbids eval.
const patchedCircuit = originalCircuit
  .replace('module.exports = class Circuit {',
    `const staticTemplates = {${templateTable}};\nconst staticFunctions = {${functionTable}};\nmodule.exports = class Circuit {`)
  .replace('eval(" const __f= " +circuitDef.templates[t] + "\\n__f")', 'staticTemplates[t]')
  .replace('eval(" const __f= " +circuitDef.functions[f].func + "\\n__f;")', 'staticFunctions[f]');
if (/\beval\s*\(/.test(patchedCircuit)) throw new Error('Legacy circuit still contains dynamic code evaluation');

const grothPath = require.resolve('websnark/src/groth16');
let grothSource = await readFile(grothPath, 'utf8');
const threadStart = grothSource.indexOf('function thread(self) {');
const threadEnd = grothSource.indexOf('// We use the Object.assign approach');
if (threadStart < 0 || threadEnd < threadStart) throw new Error('Unrecognized pinned websnark worker source');
const thread = grothSource.slice(threadStart, threadEnd).replace('process.exit();', 'self.close();');
await writeFile(path.join(output, 'groth16-worker.js'), `/* GPL-3.0-or-later: websnark worker. See LICENSE.websnark. */\n${thread}\nthread(self);\n`);

grothSource = grothSource
  .replace('const inBrowser = (typeof window !== "undefined");', 'const inBrowser = true;')
  .replace(/if \(!inBrowser\) \{[\s\S]*?\n\}/, '')
  .replace('concurrency = navigator.hardwareConcurrency;', 'concurrency = Math.min(2, navigator.hardwareConcurrency);')
  .replace('concurrency = 8;', 'concurrency = 2;')
  .replace(/const blob = new Blob\([\s\S]*?groth16\.workers\[i\] = new Worker\(url\);/,
    `const workerUrl = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL\n` +
    `  ? chrome.runtime.getURL("vendor/tornado/groth16-worker.js")\n` +
    `  : new URL("vendor/tornado/groth16-worker.js", document.baseURI).href;\n` +
    `groth16.workers[i] = new Worker(workerUrl);`);
if (/new Blob|URL\.createObjectURL/.test(grothSource)) throw new Error('Unexpected dynamically generated browser worker');

// circomlibjs uses ffjavascript in single-thread mode. Still package its optional
// worker too, so no dormant data-URL script generator remains in the extension.
const ffBrowserPath = path.join(root, 'node_modules/ffjavascript/build/browser.esm.js');
let ffBrowser = await readFile(ffBrowserPath, 'utf8');
const ffThreadStart = ffBrowser.indexOf('function thread(self) {');
const ffThreadEnd = ffBrowser.indexOf('\n/**', ffThreadStart);
if (ffThreadStart < 0 || ffThreadEnd < ffThreadStart) throw new Error('Unrecognized pinned finite-field worker');
await writeFile(path.join(output, 'ffjavascript-worker.js'),
  '/* GPL-3.0-or-later: ffjavascript worker. See LICENSE.ffjavascript. */\n' +
  ffBrowser.slice(ffThreadStart, ffThreadEnd) + '\nthread(self);\n');
ffBrowser = ffBrowser.replace(/const threadSource = [^\n]+\nconst workerSource = [^\n]+/,
  'const workerSource = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ' +
  '? chrome.runtime.getURL("vendor/tornado/ffjavascript-worker.js") ' +
  ': new URL("vendor/tornado/ffjavascript-worker.js", document.baseURI).href;');
if (/data:application\/javascript/.test(ffBrowser)) throw new Error('Unexpected generated finite-field worker');

const browserGlobals = path.join(cache, 'browser-globals.mjs');
await writeFile(browserGlobals, 'import { Buffer } from "buffer";\nimport process from "process/browser";\nexport { Buffer, process };\n');

await build({
  absWorkingDir: root,
  entryPoints: ['crypto/tornado-crypto.cjs'],
  outfile: 'extension/vendor/tornado/crypto.js',
  bundle: true,
  format: 'iife',
  globalName: 'TornadoCrypto',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'linked',
  inject: [browserGlobals],
  plugins: [{ name: 'pinned-mv3-prover', setup(builder) {
    builder.onLoad({ filter: /snarkjs[\\/]src[\\/]circuit\.js$/ }, () => ({ contents: patchedCircuit,
      resolveDir: path.dirname(require.resolve('snarkjs/src/circuit')), loader: 'js' }));
    builder.onLoad({ filter: /websnark[\\/]src[\\/]groth16\.js$/ }, () => ({ contents: grothSource,
      resolveDir: path.dirname(grothPath), loader: 'js' }));
    builder.onLoad({ filter: /ffjavascript[\\/]build[\\/]browser\.esm\.js$/ }, () => ({ contents: ffBrowser,
      resolveDir: path.dirname(ffBrowserPath), loader: 'js' }));
  } }],
});

for (const name of ['snarkjs', 'websnark', 'circomlibjs', 'ffjavascript', 'fixed-merkle-tree', 'buffer', 'assert', 'process', 'events']) {
  // These are direct, lockfile-pinned npm dependencies. Built-ins such as buffer/assert
  // must refer to the npm package, and circomlibjs does not export its package.json.
  const packageRoot = path.join(root, 'node_modules', name);
  let copied = false;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE-MIT.txt', 'COPYING']) {
    try { await copyFile(path.join(packageRoot, file), path.join(output, 'LICENSE.' + name)); copied = true; break; } catch {}
  }
  if (!copied) {
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    let license = '';
    if (metadata.license === 'GPL-3.0') license = await readFile(path.join(root, 'node_modules/snarkjs/COPYING'), 'utf8');
    if (metadata.license === 'ISC') license =
      `Copyright (c) ${metadata.author}\n\n` +
      'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\n' +
      'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n';
    await writeFile(path.join(output, 'LICENSE.' + name), `${name} ${metadata.version}\nLicense: ${metadata.license}\nRepository: ${JSON.stringify(metadata.repository)}\n\n${license}`);
  }
}
await writeFile(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log('Built pinned Tornado Classic browser prover with static witness templates and a packaged worker.');
