#!/usr/bin/env bash
# Builds the engine for the AudioWorklet, twice from the same source:
#   engine.wasm         with WebAssembly SIMD128 (-msimd128)
#   engine-scalar.wasm  without it, for browsers that lack SIMD
# The app detects SIMD support at load and fetches the matching build. The
# SIMD code uses portable vector types, which compile to scalar instructions
# when SIMD is off, so both builds produce bit-identical audio.
#
# STANDALONE_WASM + --no-entry produces a "reactor" module with no Emscripten
# JS glue: the worklet instantiates it with WebAssembly.Instance and calls the
# wr_* exports directly. Memory is fixed at startup (no growth), so views into
# it never go stale.
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR=../app/public

if ! command -v emcc >/dev/null; then
  source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
fi

build() {
  local out="$OUT_DIR/$1"
  shift
  emcc src/engine.cpp src/wasm_api.cpp \
    -std=c++20 -O3 -Wall -Wextra \
    -fno-exceptions -fno-rtti "$@" \
    -sSTANDALONE_WASM --no-entry \
    -sINITIAL_MEMORY=112MB -sALLOW_MEMORY_GROWTH=0 -sSTACK_SIZE=64KB \
    -o "$out"
  echo "built $out ($(wc -c < "$out" | tr -d ' ') bytes)"
}

build engine.wasm -msimd128
build engine-scalar.wasm
