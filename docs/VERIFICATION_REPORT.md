# Verification report v1

Native inspect/verify, the SDK file CLI, the browser workbench and the lunar experiment adapter share the `moonjls.verification/1` JSON format. See the [shared builder](../sdk/verification-report.mjs) and [TypeScript contract](../sdk/verification-report.d.mts).

## Produce a report

```sh
node sdk/cli.mjs encode --input image.raw --output image.jls --width 8 --height 8 --bits 16 --near 2 --report encode.json
node sdk/cli.mjs decode --input image.jls --output rebuilt.raw --report decode.json
node scripts/native_report.mjs ./path/to/moonjls verify image.jls 4096 > verify.json
```

The SDK CLI reads unsigned 16-bit little-endian input samples. Decode normally writes unsigned 16-bit little-endian samples in row delivery order. Set `--sample-format u32` to preserve wider reconstructed integers. The Native report adapter accepts `inspect` or `verify` and an optional initial `--wsl DISTRO` on Windows. Direct Native `inspect` and `verify` accept `--json` for low-level telemetry after strict EOF.

In the workbench, select **Download verification report** after a run completes, fails or is cancelled. [NASA example and reproducible candidate runner](../reports/lunar-budget-20261125/README.md)

## Contract

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `runId` | Contract version and local per-run identifier. Re-exporting one workbench run keeps its ID. |
| `host`, `backend`, `source`, `artifact` | Execution host, backend, checkout revision and dirty flag where available, plus codec artifact name and SHA-256. A CLI observes the checkout at report time. The browser records the core artifact digests generated into the static build manifest. |
| `input`, `output` | File name, format, known byte count, digest and optional provenance. Workbench raw planar downloads use SOF component order and report `layout`, `sampleBytes` and `endianness`. The SDK CLI reports raw storage in row delivery order. A direct browser file sink reports the actual selected name. `retained` and `complete` record storage and finalization. |
| `frame` | Dimensions, coded precision and active MAXVAL and NEAR. `preset` records the resolved scan parameters. `componentGeometry` gives true dimensions and plane offsets in samples. `scanParameters` gives Pt, coded NEAR and applicable mapping selectors and bounds. |
| `stages` | Encode, decode and compare have separate results: `not_run`, `incomplete`, `passed`, `failed` or `cancelled`. An incomplete stage started without a conclusive result. |
| `samples` | Total, verified samples, maximum absolute sample error and the applicable bound. A passing comparison covers every sample. For unmapped Pt=0 the bound is NEAR. With Pt>0 the report separates the coded error and the original-scale bound. With mapping, NEAR describes coded indices and the mapped-output bound is null. A standalone JLS decode reports comparison as `not_run`. |
| `reference` | Independent reference execution, name and version for this run. The normal CLI/workbench report paths above set `status: "not_run"`. Independent oracle runs (`scripts/verify_m2_golden.mjs` in CI, `scripts/validate_annex_e.mjs` & `scripts/test_m2.py` locally, and historical 640-case CharLS runs) remain linked to their own manifests and revisions. |
| `status`, `error` | Overall terminal result and diagnostic. An unsupported-feature diagnostic stops validation at the identified feature, leaving the rest of the codestream unverified. |
| `stream` | Decoded rows if observed, rows actually delivered to a host sink or preview, provisional rows at termination, first-row counters, strict EOI/EOF status and trailing policy. Browser rows remain provisional until successful output close. |
| `timing`, `memory`, `limits` | The timing boundary text describes what was measured. Core array payload, bridge peak and input/output peaks have separate scopes. Last output queue bytes describe the latest observed event, which may precede failure or cancellation. Host retained output is tracked separately. |
| `physical`, `unexecuted` | Physical error values require verified provenance. The latter names omitted stages and hash operations. `null` means unavailable. Zero is a measured or defined zero for the stated scope. |

Browser SHA-256 reads each eligible Blob once, up to 4 MiB, outside job timing. Buffered downloads and input files within the cap can be hashed. Direct file sinks and discarded outputs have no browser digest. For larger inputs use the streaming file CLI to capture a fingerprint. Keep the input and any downloaded artifact with the report. SHA-256 binds bytes to results. The digest supplies no certification or measurement accuracy guarantee.

See [current scope](SCOPE.md), [T.87 conformance plan](T87_CONFORMANCE_PLAN.md), [payload accounting](ARCHITECTURE.md), [conformance results](CONFORMANCE_RESULTS.md) and the [workbench handoff](SCIENTIFIC_WORKBENCH_HANDOFF.md).
