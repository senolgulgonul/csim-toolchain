# csim-toolchain

[![build](https://github.com/senolgulgonul/csim-toolchain/actions/workflows/build.yml/badge.svg)](https://github.com/senolgulgonul/csim-toolchain/actions)

Builds the in-browser C compiler for **[Derle](https://senolgulgonul.github.io/derle/)**:
clang and lld (wasm-ld) compiled to WebAssembly with Emscripten, plus a C-only
wasi-libc sysroot. Everything is built and validated in this repo's CI — no
third-party prebuilt compiler artifacts are shipped. Derle powers the free
course [Fundamentals of the C Programming Language for Embedded
Systems](https://senolgulgonul.github.io/c/).

(Historical note: Derle was called *CSim* early in development; the repo name
keeps the old prefix.)

## Pipeline

```
editor source ──> clang.wasm (-c, in-process cc1) ──> main.o
main.o + crt1.o + libc.a + compiler-rt ──> lld.wasm (-flavor wasm) ──> main.wasm
main.wasm ──> Derle WASI shim (fd 0/1/2) ──> console
```

## Version pinning

| component | version | why |
|-----------|---------|-----|
| LLVM      | `llvmorg-18.1.2` | same clang as wasi-sdk 24; the Derle shim was verified against its output |
| wasi-sdk  | 24 (sysroot + compiler-rt + resource headers) | consistent libc/headers for clang 18.1.2 |
| Emscripten| 3.1.61 | pinned; bump deliberately and re-run acceptance |

Bump all three together and let the acceptance test arbitrate.

## Layout

- `build.sh` — two-stage build: native tablegen, then `emcmake` cross-build of
  `clang` and `lld` (WebAssembly backend only, threads/PIC/zlib off, MinSizeRel).
  Applies `patches/` automatically after unpacking the LLVM tarball.
- `patches/` — the two one-line CMake patches that make LLVM emit `.mjs`
  ES-module drivers (`clang.mjs`, `lld.mjs`) instead of versioned `.js` names.
- `js/wasm_stubs.js` — `--js-library` stub for `wait4`: LLVM's Program.cpp
  references it, Emscripten's libc has no processes, and our clang never
  forks — the symbol only needs to resolve at link time.
- `scripts/package-sysroot.sh` — C-only sysroot from the pinned wasi-sdk
  release: wasi-libc headers/libs, clang resource headers, compiler-rt
  builtins. libc++ stripped (the course is C-only).
- `js/compile.mjs` — orchestration used by both Derle and CI: dependency-free
  ustar reader, MEMFS population, `compile(source) -> { ok, log, wasm }`.
- `test/acceptance.mjs` — the gate: compiles hello/echo, runs them under the
  verified Derle WASI shim (`test/shim.mjs`), asserts stdout/exit codes, and
  checks that a syntax error produces diagnostics instead of a binary.

## Artifact sizes (measured in CI)

clang.wasm 38 MB, lld.wasm 21 MB, sysroot.tar 11 MB — 68 MB total,
≈23 MB gzipped. Serve gzipped; cache with a Service Worker so students
download once. (Reference point browsercc, same approach with C++ included:
clang ≈ 43 MB, lld ≈ 23 MB, sysroot ≈ 29 MB — the C-only diet pays off.)

## Build notes (lessons already paid for)

- **Never wrap emcc/em++ with a compiler launcher.** ccache does not
  understand the Emscripten driver; every CMake `try_compile` in stage 2 then
  fails, and the first casualty is a *misleading* "libstdc++ version must be
  at least 7.4" error. `build.sh` therefore applies ccache to the native
  stage 1 only (`CCACHE_LAUNCHER`, guarded by `command -v ccache`).
- The suffix patches name the outputs plainly (`clang.mjs`, no `-18` version
  tag) — packaging and any downstream scripts must use those names.
- Emscripten's Node shell sets `process.exitCode` when a module exits
  non-zero; scripts that intentionally run failing compiles (the acceptance
  test does) must end with an explicit `process.exit(0)`.
- lld is built as the umbrella `lld` binary; the wasm flavor is selected with
  `-flavor wasm` as the first argument (in-wasm we cannot rely on argv[0]).
- clang must not fork: single translation unit + integrated cc1 (default since
  clang 10) keeps everything in-process. Do not pass flags that spawn jobs.
- If GitHub's 6 h job limit ever bites, split stage 1 and stage 2 into separate
  cached jobs; ccache already makes reruns cheap. Measured: cold run ≈ 1 h 40 m,
  warm (ccache hit) ≈ 35–40 m.

## Integration contract with Derle

Derle loads `clang.mjs`/`lld.mjs` (ES module factories), fetches `sysroot.tar`
once, and calls `createCompiler(...).compile(source)`. On success it feeds
`wasm` to the existing WASI shim — the shim needs **zero changes**.
`log` contains clang/lld diagnostics for the console panel.
