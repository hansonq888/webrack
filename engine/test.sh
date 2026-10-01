#!/usr/bin/env bash
# Builds and runs the native engine tests and benchmark.
#   ./test.sh            tests
#   ./test.sh bench      10-minute soak benchmark of the full chain
#   ./test.sh spsc       SPSC queue tests: under ThreadSanitizer, then optimized
#   ./test.sh cacheline  false-sharing benchmark
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

# -ffp-contract=off: no fused multiply-add, matching WebAssembly's float
# semantics, so native results are bit-identical to the shipped engine.wasm.
CXXFLAGS=(-std=c++20 -O2 -Wall -Wextra -fno-exceptions -ffp-contract=off)

if [[ "${1:-}" == "bench" ]]; then
  "${CXX:-c++}" "${CXXFLAGS[@]}" -O3 tests/bench.cpp src/engine.cpp -o build/bench
  ./build/bench "${@:2}"
elif [[ "${1:-}" == "spsc" ]]; then
  # ThreadSanitizer finds data races and missing happens-before edges that a
  # passing test can hide; the optimized run finds bugs that only show at speed.
  "${CXX:-c++}" -std=c++20 -O1 -g -Wall -Wextra -fsanitize=thread tests/spsc_test.cpp -o build/spsc_tsan
  echo "== ThreadSanitizer =="
  ./build/spsc_tsan
  "${CXX:-c++}" -std=c++20 -O2 -Wall -Wextra tests/spsc_test.cpp -o build/spsc_test
  echo "== optimized =="
  ./build/spsc_test
elif [[ "${1:-}" == "cacheline" ]]; then
  "${CXX:-c++}" -std=c++20 -O2 -Wall -Wextra tests/false_sharing.cpp -o build/false_sharing
  ./build/false_sharing
else
  "${CXX:-c++}" "${CXXFLAGS[@]/-fno-exceptions/}" tests/engine_test.cpp src/engine.cpp -o build/engine_test
  ./build/engine_test
fi
