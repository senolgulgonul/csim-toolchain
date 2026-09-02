// csim-toolchain/test/acceptance.mjs
// End-to-end acceptance: dist/{clang.mjs,lld.mjs,sysroot.tar} must compile
// real C source and the result must run correctly under the CSim WASI shim
// (the same shim the CSim page embeds, verified against wasi-sdk 24).
//
// Usage: node test/acceptance.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCompiler } from '../js/compile.mjs';
import { runWasi } from './shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const dec = new TextDecoder();

const clangFactory = (await import(join(dist, 'clang.mjs'))).default;
const lldFactory = (await import(join(dist, 'lld.mjs'))).default;
const sysrootTar = (await readFile(join(dist, 'sysroot.tar'))).buffer;

const compiler = createCompiler({ clangFactory, lldFactory, sysrootTar });

async function runCase(name, { stdin = '', expectOut, expectExit = 0, expectCompileFail = false }) {
  const source = await readFile(join(here, 'cases', name), 'utf8');
  const t0 = performance.now();
  const { ok, log, wasm } = await compiler.compile(source, { fileName: name });
  const compileMs = Math.round(performance.now() - t0);

  if (expectCompileFail) {
    if (ok) throw new Error(`${name}: expected compile failure, but it compiled`);
    if (!log.trim()) throw new Error(`${name}: compile failed but produced no diagnostics`);
    console.log(`ok  ${name} — compile fails with diagnostics (${compileMs} ms)`);
    return;
  }

  if (!ok) throw new Error(`${name}: compile failed:\n${log}`);

  let out = '';
  const { exitCode } = await runWasi(wasm, new TextEncoder().encode(stdin), {
    onStdout: b => out += dec.decode(b, { stream: true }),
    onStderr: b => out += dec.decode(b, { stream: true }),
  });
  if (out !== expectOut) throw new Error(`${name}: stdout mismatch:\n got: ${JSON.stringify(out)}\n want: ${JSON.stringify(expectOut)}`);
  if (exitCode !== expectExit) throw new Error(`${name}: exit ${exitCode}, want ${expectExit}`);
  console.log(`ok  ${name} — compiled ${compileMs} ms, ran correctly (exit ${exitCode})`);
}

await runCase('hello.c', { expectOut: 'Hello, CSim!\nint is 4 bytes\n' });
await runCase('echo.c', { stdin: 'Ayse 7 35\n', expectOut: 'Hi Ayse, 7 + 35 = 42\n' });
await runCase('echo.c', { stdin: '', expectOut: 'input error\n', expectExit: 1 });
await runCase('syntax-error.c', { expectCompileFail: true });

console.log('acceptance: all cases pass');
// Emscripten's node shell sets process.exitCode when clang exits non-zero —
// which the syntax-error case does on purpose. Exit explicitly so the
// verdict above is also the process's verdict.
process.exit(0);
