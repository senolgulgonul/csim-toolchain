#!/usr/bin/env bash
# csim-toolchain: build clang + lld as WebAssembly modules for the browser,
# and package a C-only wasi sysroot.
#
# Version pinning rationale: the CSim WASI shim was verified against binaries
# produced by wasi-sdk 24, which ships clang 18.1.2. We build the same LLVM
# tag and take the sysroot from the same wasi-sdk release, so the compiler,
# resource headers, compiler-rt and libc are a proven-consistent set.
set -euo pipefail

LLVM_TAG="llvmorg-18.1.2"
WASI_SDK_VER="24"
EMSDK_VER="3.1.61"          # known-good with LLVM 18-era builds; bump deliberately
JOBS="${JOBS:-$(nproc)}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/work/llvm-project"
STAGE1="$ROOT/work/stage1"   # native host tools (tablegen)
STAGE2="$ROOT/work/stage2"   # wasm cross build
DIST="$ROOT/dist"

mkdir -p "$ROOT/work" "$DIST"

# ccache only for the native stage 1 build. Never wrap emcc/em++ with a
# compiler launcher: ccache does not understand the emscripten driver and
# every CMake try_compile in stage 2 fails (first casualty: the misleading
# "libstdc++ version must be at least 7.4" error from CheckCompilerVersion).
CCACHE_LAUNCHER=""
if command -v ccache >/dev/null 2>&1; then
  CCACHE_LAUNCHER="-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"
fi

# ---------------------------------------------------------------- emsdk
if [ ! -d "$ROOT/work/emsdk" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$ROOT/work/emsdk"
fi
"$ROOT/work/emsdk/emsdk" install "$EMSDK_VER"
"$ROOT/work/emsdk/emsdk" activate "$EMSDK_VER"
source "$ROOT/work/emsdk/emsdk_env.sh"

# ---------------------------------------------------------------- sources
apply_patches() {
  for p in "$ROOT"/patches/*.patch; do
    patch -p0 -N -d "$ROOT" < "$p" || true
  done
}

if [ ! -d "$SRC" ]; then
  curl -sL "https://github.com/llvm/llvm-project/archive/refs/tags/$LLVM_TAG.tar.gz" \
    | tar xz -C "$ROOT/work"
  mv "$ROOT/work/llvm-project-"* "$SRC"
  apply_patches
fi

# ---------------------------------------------------- stage 1: native tablegen
# Only the code generators that the cross build needs to run on the host.
cmake -S "$SRC/llvm" -B "$STAGE1" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_ENABLE_PROJECTS="clang" \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  ${CCACHE_LAUNCHER:-}
ninja -C "$STAGE1" llvm-tblgen clang-tblgen

# ---------------------------------------------------- stage 2: wasm cross build
# MinSizeRel + single target backend keeps clang.wasm/lld.wasm as small as
# LLVM allows. Threads off (plain wasm), PIC off, optional deps off.
COMMON_EMS_FLAGS="-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
 -sALLOW_MEMORY_GROWTH=1 -sWASM_BIGINT=1 -sSTACK_SIZE=8388608 \
 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
 -sEXPORTED_RUNTIME_METHODS=FS,callMain --js-library $ROOT/js/wasm_stubs.js"

emcmake cmake -S "$SRC/llvm" -B "$STAGE2" -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasi \
  -DLLVM_TABLEGEN="$STAGE1/bin/llvm-tblgen" \
  -DCLANG_TABLEGEN="$STAGE1/bin/clang-tblgen" \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_PIC=OFF \
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_BUILD_TOOLS=OFF \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCMAKE_EXE_LINKER_FLAGS="$COMMON_EMS_FLAGS"
ninja -C "$STAGE2" clang lld

# ---------------------------------------------------------------- package
# The suffix patch names the outputs plainly (no -18 version tag): clang.mjs,
# clang.wasm, lld.mjs, lld.wasm. Proven by CI run #4 (both links green).
cp "$STAGE2/bin/clang.mjs"  "$DIST/clang.mjs"
cp "$STAGE2/bin/clang.wasm" "$DIST/clang.wasm"
cp "$STAGE2/bin/lld.mjs"    "$DIST/lld.mjs"
cp "$STAGE2/bin/lld.wasm"   "$DIST/lld.wasm"

"$ROOT/scripts/package-sysroot.sh" "$WASI_SDK_VER" "$DIST"

{
  echo "llvm=$LLVM_TAG"
  echo "wasi-sdk=$WASI_SDK_VER"
  echo "emsdk=$EMSDK_VER"
  echo "built=$(date -u +%Y-%m-%dT%H:%MZ)"
} > "$DIST/VERSION"

ls -lh "$DIST"
echo "done — run 'node test/acceptance.mjs' to validate the full pipeline"
