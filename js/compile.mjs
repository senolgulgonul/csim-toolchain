// csim-toolchain/js/compile.mjs
// Orchestrates the in-browser pipeline: clang (compile .c -> .o) and
// wasm-ld (link .o -> .wasm), both running as Emscripten modules with a
// MEMFS holding the sysroot. Works identically in a Worker and in Node,
// which is how the CI acceptance test exercises the real artifacts.

const RES_VER = '18'; // clang resource dir version; matches VERSION file

/* ---------------- minimal ustar reader (no dependencies) ---------------- */
export function* untar(buf) {
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  let off = 0;
  const str = (start, len) => {
    const end = Math.min(start + len, u8.length);
    let s = dec.decode(u8.subarray(start, end));
    const nul = s.indexOf('\0');
    return nul === -1 ? s : s.slice(0, nul);
  };
  while (off + 512 <= u8.length) {
    const name = str(off, 100);
    if (!name) break;                              // two zero blocks = end
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = str(off + 156, 1);
    const prefix = str(off + 345, 155);
    const path = prefix ? prefix + '/' + name : name;
    const body = u8.subarray(off + 512, off + 512 + size);
    yield { path, type, body };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

function loadTarIntoFS(FS, tarBuf, stripPrefix = 'sysroot/', mountAt = '/sysroot/') {
  for (const { path, type, body } of untar(tarBuf)) {
    if (!path.startsWith(stripPrefix)) continue;
    const rel = path.slice(stripPrefix.length);
    if (!rel) continue;
    const full = mountAt + rel;
    if (type === '5') {
      FS.mkdirTree ? FS.mkdirTree(full) : mkdirp(FS, full);
    } else if (type === '0' || type === '') {
      const dir = full.slice(0, full.lastIndexOf('/'));
      FS.mkdirTree ? FS.mkdirTree(dir) : mkdirp(FS, dir);
      FS.writeFile(full, body);
    }
  }
}

function mkdirp(FS, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    try { FS.mkdir(cur); } catch (e) { /* exists */ }
  }
}

/* ------------------------------ compiler ------------------------------- */
// createCompiler({ clangFactory, lldFactory, sysrootTar })
//   clangFactory / lldFactory: the default exports of clang.mjs / lld.mjs
//   sysrootTar: ArrayBuffer of dist/sysroot.tar
// Returns { compile(source, opts) } where opts = { fileName, flags }.
// compile() resolves to { ok, log, wasm } — wasm is a Uint8Array on success.
export function createCompiler({ clangFactory, lldFactory, sysrootTar }) {

  async function runTool(factory, args, files, wantFile) {
    let log = '';
    const mod = await factory({
      print: s => { log += s + '\n'; },
      printErr: s => { log += s + '\n'; },
      noInitialRun: true,
    });
    loadTarIntoFS(mod.FS, sysrootTar);
    mod.FS.mkdirTree ? mod.FS.mkdirTree('/work') : mkdirp(mod.FS, '/work');
    for (const [path, data] of Object.entries(files)) {
      mod.FS.writeFile('/work/' + path,
        typeof data === 'string' ? new TextEncoder().encode(data) : data);
    }
    let code;
    try { code = mod.callMain(args); }
    catch (e) { if (typeof e === 'number') code = e; else if (e && e.name === 'ExitStatus') code = e.status; else throw e; }
    let out = null;
    if (code === 0 && wantFile) out = mod.FS.readFile('/work/' + wantFile);
    return { code, log, out };
  }

  async function compile(source, { fileName = 'main.c', flags = [] } = {}) {
    // ---- 1) clang: C source -> object file (in-process cc1, no fork) ----
    const clangArgs = [
      '--target=wasm32-wasi',
      '--sysroot=/sysroot',
      `-resource-dir=/sysroot/lib/clang/${RES_VER}`,
      '-c', '/work/' + fileName,
      '-o', '/work/main.o',
      '-O1',
      ...flags,
    ];
    const c = await runTool(clangFactory, clangArgs, { [fileName]: source }, 'main.o');
    if (c.code !== 0) return { ok: false, log: c.log, wasm: null };

    // ---- 2) lld (wasm flavor): object + libc -> executable .wasm --------
    const lldArgs = [
      '-flavor', 'wasm',
      '/sysroot/lib/wasm32-wasi/crt1.o',
      '/work/main.o',
      '-L/sysroot/lib/wasm32-wasi',
      '-lc',
      `/sysroot/lib/clang/${RES_VER}/lib/wasi/libclang_rt.builtins-wasm32.a`,
      '-o', '/work/main.wasm',
    ];
    const l = await runTool(lldFactory, lldArgs, { 'main.o': c.out }, 'main.wasm');
    if (l.code !== 0) return { ok: false, log: c.log + l.log, wasm: null };

    return { ok: true, log: c.log + l.log, wasm: l.out };
  }

  return { compile };
}
