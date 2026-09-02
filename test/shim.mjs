// CSim WASI shim — minimal wasi_snapshot_preview1 for classroom C programs.
// Covers fd 0/1/2 only: fd_write -> console, fd_read -> pre-filled stdin
// buffer, proc_exit -> exit code. Everything else is a safe stub.

const ERRNO_SUCCESS = 0, ERRNO_BADF = 8, ERRNO_NOSYS = 52, ERRNO_SPIPE = 70;

class ProcExit { constructor(code) { this.code = code; } }

// Runs a wasi .wasm. `io` gets: onStdout(bytes), onStderr(bytes).
// Returns { exitCode }.
async function runWasi(wasmBytes, stdinBytes, io) {
  let memory;               // set after instantiation
  let stdinPos = 0;

  const view = () => new DataView(memory.buffer);

  function readIovs(iovsPtr, iovsLen) {
    const dv = view(), parts = [];
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const ptr = dv.getUint32(iovsPtr + i * 8, true);
      const len = dv.getUint32(iovsPtr + i * 8 + 4, true);
      parts.push({ ptr, len });
      total += len;
    }
    return { parts, total };
  }

  const wasi = {
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      if (fd !== 1 && fd !== 2) return ERRNO_BADF;
      const { parts, total } = readIovs(iovsPtr, iovsLen);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        out.set(new Uint8Array(memory.buffer, p.ptr, p.len), off);
        off += p.len;
      }
      view().setUint32(nwrittenPtr, total, true);
      (fd === 2 ? io.onStderr : io.onStdout)(out);
      return ERRNO_SUCCESS;
    },
    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      if (fd !== 0) return ERRNO_BADF;
      const { parts } = readIovs(iovsPtr, iovsLen);
      let nread = 0;
      for (const p of parts) {
        const n = Math.min(p.len, stdinBytes.length - stdinPos);
        if (n <= 0) break;
        new Uint8Array(memory.buffer, p.ptr, n)
          .set(stdinBytes.subarray(stdinPos, stdinPos + n));
        stdinPos += n; nread += n;
      }
      view().setUint32(nreadPtr, nread, true); // nread=0 => EOF
      return ERRNO_SUCCESS;
    },
    proc_exit(code) { throw new ProcExit(code); },

    // --- stubs sufficient for wasi-libc startup ---
    args_sizes_get(argcPtr, bufSizePtr) {
      view().setUint32(argcPtr, 0, true);
      view().setUint32(bufSizePtr, 0, true);
      return ERRNO_SUCCESS;
    },
    args_get() { return ERRNO_SUCCESS; },
    environ_sizes_get(countPtr, bufSizePtr) {
      view().setUint32(countPtr, 0, true);
      view().setUint32(bufSizePtr, 0, true);
      return ERRNO_SUCCESS;
    },
    environ_get() { return ERRNO_SUCCESS; },
    clock_time_get(_id, _prec, timePtr) {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true);
      return ERRNO_SUCCESS;
    },
    random_get(bufPtr, len) {
      const buf = new Uint8Array(memory.buffer, bufPtr, len);
      if (globalThis.crypto?.getRandomValues) {
        for (let i = 0; i < len; i += 65536)
          globalThis.crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, len)));
      } else {
        for (let i = 0; i < len; i++) buf[i] = (Math.random() * 256) | 0;
      }
      return ERRNO_SUCCESS;
    },
    fd_fdstat_get(fd, statPtr) {
      if (fd > 2) return ERRNO_BADF;
      new Uint8Array(memory.buffer, statPtr, 24).fill(0);
      view().setUint8(statPtr, 2); // filetype: character_device
      return ERRNO_SUCCESS;
    },
    fd_prestat_get() { return ERRNO_BADF; }, // no preopened dirs
    fd_close() { return ERRNO_SUCCESS; },
    fd_seek() { return ERRNO_SPIPE; },
    fd_fdstat_set_flags() { return ERRNO_SUCCESS; },
  };

  const module = await WebAssembly.compile(wasmBytes);
  // Fill any WASI import we didn't implement with an ENOSYS stub, so an
  // unexpected libc call fails loudly-but-safely instead of failing to link.
  const imports = { wasi_snapshot_preview1: {} };
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'wasi_snapshot_preview1') continue;
    imports.wasi_snapshot_preview1[imp.name] =
      wasi[imp.name] ?? (() => ERRNO_NOSYS);
  }

  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory;

  try {
    instance.exports._start();
    return { exitCode: 0 };            // main returned normally
  } catch (e) {
    if (e instanceof ProcExit) return { exitCode: e.code };
    throw e;                           // trap (e.g. unreachable) — real error
  }
}


export { runWasi };
