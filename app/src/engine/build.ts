// Which engine build to load. engine.wasm uses WebAssembly SIMD128; browsers
// without SIMD get engine-scalar.wasm, built from the same source without
// -msimd128, which produces bit-identical audio more slowly.
//
// Detection validates a tiny module that uses one SIMD instruction:
//   (func (result v128) i32.const 0  i8x16.splat  i8x16.popcnt)
// A browser that can't decode it doesn't support SIMD.

const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type section: () -> v128
  0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
  0x0a, 0x0a, 0x01, 0x08, 0x00, // code section: one body, no locals
  0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b, // i32.const 0; i8x16.splat; i8x16.popcnt; end
])

export type EngineBuild = 'simd' | 'scalar'

export const simdSupported: boolean = WebAssembly.validate(SIMD_PROBE)

export const ENGINE_URLS: Record<EngineBuild, string> = {
  simd: '/engine.wasm',
  scalar: '/engine-scalar.wasm',
}

/** The build this browser should run. `?engine=scalar` forces the fallback (for testing). */
export function preferredBuild(search = globalThis.location?.search ?? ''): EngineBuild {
  if (new URLSearchParams(search).get('engine') === 'scalar') return 'scalar'
  return simdSupported ? 'simd' : 'scalar'
}
