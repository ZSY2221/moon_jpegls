# Clean-checkout verification

The clean-checkout run on 2026-11-23 used source commit `bcca320ff2fd3d36cbfa10b5e3138f2887256251`. Later commits add reports and release records. Native ran in Ubuntu 22.04.2 WSL2. Node, npm, Chrome and the JS/Wasm GC MoonBit builds ran on Windows.

| Command or check | Observed outcome |
| --- | --- |
| `moon check --target all --deny-warn` | Passed |
| `moon test core --target js --deny-warn` | 7 passed |
| `moon test core --target wasm-gc --deny-warn` | 7 passed |
| `moon test core --target native --deny-warn` in WSL | 7 passed |
| `moon build cmd/moonjls --target native --release` in WSL | Built the native ELF and ran its help command |
| `moon -C examples/consumer update` and `moon -C examples/consumer run . --target wasm-gc` | Verified 12-bit round-trip and Gray16 adapter, 48 B and 60 B compressed |
| `node sdk/build.mjs`, `node web/build.mjs` | Built JS, Wasm GC and the static browser directory |
| `python -m http.server` bound to loopback, `npm --prefix web ci`, `npm --prefix web run smoke` | Chrome `158.0.8127.37` passed on the static release tree |
| `moon package` | Local source package built, with a warning that the unpublished module has no repository URL |

The browser run encoded the 400 × 260 sample at 16 bits and NEAR=3 in Wasm GC, producing 105,655 bytes and a maximum absolute error of 3. The downloaded stream decoded in JS to a 208,017-byte PGM. Bounded consumption, locale switching, invalid and unsupported input, and pause/cancel passed. In a one-byte-input Worker job, the number of source requests stayed at 59 while the acknowledgement was held and while the Worker was paused. The decoded row queue peaked at 8 bytes. Edge `158.0.4370.33` passed the same suite on the built static tree in the main checkout. [Screenshot](screenshots/workbench.png)

The external reference suite and resource benchmarks are separate runs. Their pinned data, versions, counts and measurements are in [Validation](../docs/VALIDATION.md) and [Benchmarks](../docs/BENCHMARK.md).
