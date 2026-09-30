#!/usr/bin/env bash
# Builds engine.wasm for the AudioWorklet.
#
# STANDALONE_WASM + --no-entry produces a "reactor" module with no Emscripten
# JS glue: the worklet instantiates it with WebAssembly.Instance and calls the
# wr_* exports directly. Memory is fixed at startup (no growth), so views into
# it never go stale.
set -euo pipefail

cd "$(dirname "$0")"
OUT=../app/public/engine.wasm

if ! command -v emcc >/dev/null; then
  source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
fi

emcc src/engine.cpp src/wasm_api.cpp \
  -std=c++20 -O3 -Wall -Wextra \
  -fno-exceptions -fno-rtti \
  -sSTANDALONE_WASM --no-entry \
  -sINITIAL_MEMORY=112MB -sALLOW_MEMORY_GROWTH=0 -sSTACK_SIZE=64KB \
  -o "$OUT"

echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
