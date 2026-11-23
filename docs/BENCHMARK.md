# Benchmarks

Measurements were recorded on 2026-11-23 on an AMD Ryzen 9 8945HX with 32 logical CPUs and 16,341,377,024 bytes of host RAM. The release MoonBit SDK was `moon 0.1.20261119` (`738607b`), compiler `v0.10.22+124d61d05`. JS and Wasm GC ran under Windows Node 24.20.0. The Native CLI was built using clang 14 and ran in Ubuntu 22.04 WSL2 on kernel `6.18.33.2-microsoft-standard-WSL2`, glibc 2.35. The [Node and Windows reference samples](../reports/benchmark.json) and [WSL Native samples](../reports/native-wsl.json) contain raw timings and artifact sizes.

## Resource behavior

Each resource case runs in a fresh Node process. At width 512, the height changes from 64 to 512 to 4,096 with fixed 16-bit lossless input. The sample generator fills one reusable array on demand. The decoder stages an 8 KiB file-read buffer from a prebuilt CharLS stream and checks each output row against the generator before discarding it. The encoder sends encoded bytes to a checksum sink. Neither path uses a full-frame source buffer or collects the full output during measurement. Fixture construction is outside the measured process.

| Observed metric at all three heights | JS and Wasm GC encode | JS and Wasm GC decode |
| --- | ---: | ---: |
| Maximum allocated core buffer payload | 9,992 B | 10,751 B |
| Normal input chunk payload peak | 8,192 B | 4,096 B |
| Minimum input chunk payload peak | 2 B | 1 B |
| Normal output payload peak | 533 B | 1,024 B |
| Minimum output payload peak | 1 B | 1,024 B |
| Normal / minimum SDK bridge buffers | 20,480 B / 5 B | 8,192 B / 2 B |
| Input consumed when the first row event occurs | 512 samples | 573 encoded bytes |

Core buffer payload counts the allocated predictor and context elements and the allocated marker and queued byte arrays. Scalar bookkeeping is outside that count. SDK bridge copies, the fixture reader buffer, emitted typed arrays, object headers, allocator/JIT overhead and garbage collection affect other counters. The `bridgeBufferPeakBytes` field includes the bridge allocations alongside the currently staged decoder input copy. The paused-sink run at height 512 explicitly records one queued encode byte or one queued 1,024-byte row, with zero and 3,523 bytes of staged input remaining respectively. The observed sink wait was requested for 20 ms. The test asserts zero new reads and zero subsequent deliveries until release. Throughput trials use a sink without a scripted delay.

Process peak resident bytes come from Node `process.resourceUsage().maxRSS * 1024`. The range was 47.1–56.1 MiB across fresh children. This includes executable, runtimes, compiled code and other process memory. It is sampled over the process lifetime and includes initialization. At the smallest height, the first decode row was delivered before the second read of the normal stream. The row still appeared after byte 573 under minimum chunks. Reported first-row elapsed time includes startup of the stream driver after asset load.

| 512×4096 lossless | Normal, raw MiB/s | Minimum, raw MiB/s |
| --- | ---: | ---: |
| JS encode | 22.40 | 3.73 |
| JS decode | 17.82 | 6.16 |
| Wasm GC encode | 23.06 | 3.08 |
| Wasm GC decode | 16.35 | 5.24 |

Normal means 4,096 input elements per call and up to 4,096 output bytes per encode call. Minimum means one input element and one encode output byte. Both decoder schedules emit one row at a time. Raw throughput is `width × height × 2 ÷ 1,048,576 ÷ elapsed_seconds`. The raw sample representation is two bytes. This measurement is for the Node SDK driver with its real bridge and sink callbacks. Exact allocation accounting, build assumptions and limitations are in [Architecture](ARCHITECTURE.md).

## Compression and precision

The four 768×512 synthetic fixtures cover a smooth ramp, sharp edges, textured values and seeded noise. The public fixtures are a 512×512 CC0 fluorescence microscopy crop with 12 effective bits and a 1440×720 NASA lunar elevation grid with 16-bit storage. All codecs receive the same integer samples. The PNG control uses grayscale 16-bit storage and libpng level 6. For the 12-bit Lily crop, the values stay within 0–4095, and PNG’s 16-bit representation preserves those values. Annex E conformance images are used only for verification. [Fixture provenance](../tests/fixtures/README.md).

| Fixture | PNG lossless bytes | MoonJLS NEAR=0 bytes | MoonJLS NEAR=3 bytes | Observed error at NEAR=3 |
| --- | ---: | ---: | ---: | ---: |
| Smooth | 9,144 | 52,942 | 52,650 | 3 |
| Edges | 2,250 | 20,117 | 19,980 | 1 |
| Texture | 631,270 | 457,797 | 320,220 | 3 |
| Noise | 788,404 | 811,643 | 673,516 | 3 |
| Lily microscopy | 374,355 | 294,041 | 207,347 | 3 |
| Lunar elevation | 1,649,661 | 1,363,687 | 999,459 | 3 |

Every lossless run reconstructed exactly. PNG is smaller on the smooth, edge and lossless noise fixtures. MoonJLS is smaller on these texture, microscopy and lunar samples. NEAR=3 trades absolute sample error for size under a different precision contract. Compression ratio is two-byte raw sample payload divided by actual compressed file bytes for each row of this table.

## Timing and package scope

For each image and NEAR setting, one trial is reported separately as `FirstMs`, followed by the median of three trials in the same harness. Node first module-load and initialization observations were 1.70 ms for MoonJLS JS, 1.16 ms for MoonJLS Wasm GC and 6.13 ms for the official CharLS npm package plus its two instances. Disk loading of input images is outside transform timing. For MoonJLS the Node timings include SDK stream handling, bridge copies and per-row or per-block sink calls. The effect benchmark collects full result buffers when assembling per-image metrics. The CharLS wrapper performs a whole-image array conversion, copies data into Wasm, and copies the returned results. Both run under the same Node process and expose different buffer contracts.

| NEAR=0 fixture | Node JS encode/decode ms | Node Wasm GC encode/decode ms | Node CharLS Wasm encode/decode ms |
| --- | ---: | ---: | ---: |
| Smooth | 20.60 / 33.24 | 22.27 / 29.87 | 5.59 / 4.42 |
| Edges | 12.54 / 13.54 | 17.06 / 17.36 | 2.10 / 1.72 |
| Texture | 34.09 / 60.99 | 38.98 / 54.59 | 9.14 / 9.61 |
| Noise | 41.84 / 70.34 | 50.58 / 69.37 | 9.04 / 12.39 |
| Lily microscopy | 27.78 / 42.55 | 31.10 / 42.77 | 5.24 / 7.29 |
| Lunar elevation | 109.03 / 174.66 | 123.77 / 171.29 | 20.96 / 30.16 |

The WSL report measures MoonJLS release CLI process startup, stdin/stdout pipe transport and compression. CharLS 2.4.5 and libpng 1.6.59 are timed in the same WSL distro through prebuilt native `imagecodecs 2026.11.11`, using CPython 3.12.16. Those runs use whole-buffer native calls. The timing boundaries differ, so the report keeps the Native CLI wall times alongside the in-process reference figures. The Node CharLS Wasm baseline is version 0.10.0 at `7b95b8fcbb3c9bd9183d02820c736afb63fcd2c4`, with its CharLS submodule at `5a2481fb28573149e72621aefaabf5aa9eaf0eb1`. The native and Wasm references use different upstream revisions. Browser correctness smoke results are documented separately. [Wasm release source](https://github.com/team-charls/charls-wasm/tree/7b95b8fcbb3c9bd9183d02820c736afb63fcd2c4).

| Runnable SDK scope | Raw bytes | Sum of per-file gzip bytes |
| --- | ---: | ---: |
| MoonJLS JS core and SDK glue | 111,677 | 17,480 |
| MoonJLS Wasm GC core and SDK glue | 28,785 | 11,273 |
| Official CharLS Wasm and SDK glue | 224,133 | 61,539 |

Sizes include the required runtime and loader code distributed with each direct Node/browser interface. The Worker, browser demo and source maps sit outside this measurement. Gzip uses level 9 with a fixed timestamp. The CharLS package and MoonJLS support different JPEG-LS feature ranges.

## Reproduce

Install the pinned oracles and build the SDK as in [Validation](VALIDATION.md). The Linux driver additionally needs Python 3.12+ with the same `scripts/oracle-requirements.txt` wheels. The measured WSL environment uses the prebuilt Astral CPython 3.12.16 install-only stripped archive from release `20261110`, SHA-256 `6a9e62dad033790aef722dbd370e0ce76ce17b73627ba3ae679f537049350b39`. [Pinned Python archive](https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz).

```powershell
./.tools/oracle-venv/Scripts/python.exe scripts/benchmark.py --real-data --repeats 3
python -m pip download --only-binary=:all: --platform manylinux_2_28_x86_64 --implementation cp --python-version 3.12 --abi cp312 --dest .tools/oracle-wheels -r scripts/oracle-requirements.txt
wsl -d Ubuntu-22.04 --exec bash -lc 'mkdir -p .tools/linux-python312 && tar -xzf .tools/cpython-3.12-linux.tar.gz -C .tools/linux-python312'
wsl -d Ubuntu-22.04 --exec .tools/linux-python312/python/bin/python3.12 -m pip install --no-index --only-binary=:all: --find-links .tools/oracle-wheels --target .tools/linux-oracle-pydeps -r scripts/oracle-requirements.txt
wsl -d Ubuntu-22.04 --exec .tools/linux-python312/python/bin/python3.12 scripts/native_benchmark.py .evidence/benchmark .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe --deps .tools/linux-oracle-pydeps
```

Save the pinned Python archive under `.tools/cpython-3.12-linux.tar.gz` before the extraction command. Reports and generated image inputs stay under `.evidence/benchmark/`. `--mode resource` and `--mode effect` run the two groups independently. `--real-data` explicitly opts into the pinned public downloads. The fixture generator and reference timings are development scripts outside the distributed codec.
