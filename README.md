# csim-toolchain

Builds the in-browser C compiler for **CSim**: clang and lld (wasm-ld) compiled
to WebAssembly with Emscripten, plus a C-only wasi-libc sysroot. Everything is
built and validated in this repo's CI — no third-party prebuilt compiler
artifacts are shipped.

## Pipeline

```
editor source ──> clang.wasm (-c, in-process cc1) ──> main.o
main.o + crt1.o + libc.a + compiler-rt ──> lld.wasm (-flavor wasm) ──> main.wasm
main.wasm ──> CSim WASI shim (fd 0/1/2) ──> console
```

## Version pinning

| component | version | why |
|-----------|---------|-----|
| LLVM      | `llvmorg-18.1.2` | same clang as wasi-sdk 24; the CSim shim was verified against its output |
| wasi-sdk  | 24 (sysroot + compiler-rt + resource headers) | consistent libc/headers for clang 18.1.2 |
| Emscripten| 3.1.61 | pinned; bump deliberately and re-run acceptance |

Bump all three together and let the acceptance test arbitrate.

## Layout

- `build.sh` — two-stage build: native tablegen, then `emcmake` cross-build of
  `clang` and `lld` (WebAssembly backend only, threads/PIC/zlib off, MinSizeRel).
- `scripts/package-sysroot.sh` — C-only sysroot from the pinned wasi-sdk
  release: wasi-libc headers/libs, clang resource headers, compiler-rt
  builtins. libc++ stripped (the course is C-only).
- `js/compile.mjs` — orchestration used by both CSim and CI: dependency-free
  ustar reader, MEMFS population, `compile(source) -> { ok, log, wasm }`.
- `test/acceptance.mjs` — the gate: compiles hello/echo, runs them under the
  verified CSim WASI shim (`test/shim.mjs`), asserts stdout/exit codes, and
  checks that a syntax error produces diagnostics instead of a binary.

## Expected artifact sizes

Reference point (browsercc, same approach, LLVM built with size flags):
clang.wasm ≈ 43 MB, lld.wasm ≈ 23 MB, sysroot ≈ 29 MB with C++ included.
Ours should land lower: C-only sysroot and no-LTO lld. Serve gzipped
(CI prints .gz sizes); cache with a Service Worker so students download once.

## Known risks / first-run expectations

- The heavy cross-build is the untested half: expect a debug iteration or two
  in CI (tablegen paths, executable suffix quirks, Emscripten version drift).
  `build.sh` is written to fail loudly at the exact step.
- lld is built as the umbrella `lld` binary; the wasm flavor is selected with
  `-flavor wasm` as the first argument (in-wasm we cannot rely on argv[0]).
- clang must not fork: single translation unit + integrated cc1 (default since
  clang 10) keeps everything in-process. Do not pass flags that spawn jobs.
- If GitHub's 6 h job limit ever bites, split stage 1 and stage 2 into separate
  cached jobs; ccache already makes reruns cheap.

## Integration contract with CSim

CSim loads `clang.mjs`/`lld.mjs` (ES module factories), fetches `sysroot.tar`
once, and calls `createCompiler(...).compile(source)`. On success it feeds
`wasm` to the existing WASI shim — the shim needs **zero changes**.
`log` contains clang/lld diagnostics for the console panel.
