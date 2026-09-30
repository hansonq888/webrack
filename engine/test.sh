#!/usr/bin/env bash
# Builds and runs the native engine tests and benchmark.
#   ./test.sh          tests
#   ./test.sh bench    10-minute soak benchmark of the full chain
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

CXXFLAGS=(-std=c++20 -O2 -Wall -Wextra -fno-exceptions)

if [[ "${1:-}" == "bench" ]]; then
  c++ "${CXXFLAGS[@]}" -O3 tests/bench.cpp src/engine.cpp -o build/bench
  ./build/bench "${@:2}"
else
  c++ "${CXXFLAGS[@]/-fno-exceptions/}" tests/engine_test.cpp src/engine.cpp -o build/engine_test
  ./build/engine_test
fi
