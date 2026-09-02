#!/usr/bin/env bash
# Package a C-only sysroot from the pinned wasi-sdk release.
# Contents: wasi-libc headers + libs (wasm32-wasi only), clang resource
# headers (stddef.h & friends), compiler-rt builtins. C++ is stripped —
# the course is C-only and libc++ dominates the sysroot size.
set -euo pipefail

WASI_SDK_VER="${1:?usage: package-sysroot.sh <wasi-sdk-version> <dist-dir>}"
DIST="${2:?usage: package-sysroot.sh <wasi-sdk-version> <dist-dir>}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_VER/wasi-sdk-$WASI_SDK_VER.0-x86_64-linux.tar.gz"
curl -sL "$URL" | tar xz -C "$WORK"
SDK="$WORK/wasi-sdk-$WASI_SDK_VER.0-x86_64-linux"

OUT="$WORK/sysroot"
mkdir -p "$OUT/include" "$OUT/lib/wasm32-wasi" "$OUT/lib/clang"

# wasi-libc headers and libraries (single-threaded wasm32-wasi flavor)
cp -r "$SDK/share/wasi-sysroot/include/wasm32-wasi/." "$OUT/include/" 2>/dev/null || \
cp -r "$SDK/share/wasi-sysroot/include/."             "$OUT/include/"
rm -rf "$OUT/include/c++"
cp "$SDK/share/wasi-sysroot/lib/wasm32-wasi/"*.a "$OUT/lib/wasm32-wasi/"
cp "$SDK/share/wasi-sysroot/lib/wasm32-wasi/"crt1*.o "$OUT/lib/wasm32-wasi/"
rm -f "$OUT/lib/wasm32-wasi/"libc++*.a

# clang resource dir: builtin headers + compiler-rt builtins, versioned path
RES_SRC="$(echo "$SDK"/lib/clang/*)"
RES_VER="$(basename "$RES_SRC")"
mkdir -p "$OUT/lib/clang/$RES_VER/lib/wasi"
cp -r "$RES_SRC/include" "$OUT/lib/clang/$RES_VER/include"
cp "$RES_SRC"/lib/wasi/libclang_rt.builtins-wasm32.a "$OUT/lib/clang/$RES_VER/lib/wasi/" 2>/dev/null || \
cp "$RES_SRC"/lib/wasm32-unknown-wasi/libclang_rt.builtins.a "$OUT/lib/clang/$RES_VER/lib/wasi/libclang_rt.builtins-wasm32.a"

# Plain ustar, uncompressed: served with gzip/brotli by the web layer, and
# trivially parsed by the ~60-line untar in js/compile.mjs.
tar --format=ustar -C "$WORK" -cf "$DIST/sysroot.tar" sysroot
echo "resource-dir-version=$RES_VER" >> "$DIST/VERSION" 2>/dev/null || true
ls -lh "$DIST/sysroot.tar"
