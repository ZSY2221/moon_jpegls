# Verification report v1

Native inspect/verify, the SDK file CLI, the browser workbench and the lunar experiment adapter share the `moonjls.verification/1` JSON format. See the [shared builder](../sdk/verification-report.mjs) and [TypeScript contract](../sdk/verification-report.d.mts).

## Produce a report

```sh
node sdk/cli.mjs encode --input image.raw --output image.jls --width 8 --height 8 --bits 16 --near 2 --report encode.json
node sdk/cli.mjs decode --input image.jls --output rebuilt.raw --report decode.json
node scripts/native_report.mjs ./path/to/moonjls verify image.jls 4096 > verify.json
```

The SDK CLI uses unsigned 16-bit little-endian raw storage at each supported coded precision and creates the report at a distinct new path. Existing console summaries remain available. The Native report adapter accepts `inspect` or `verify` and an optional initial `--wsl Ubuntu-22.04` when the Node host runs on Windows. Direct Native `inspect` and `verify` accept `--json` for low-level telemetry after strict EOF.

In the workbench, select **Download verification report** after a run completes, fails or is cancelled. [NASA example and reproducible candidate runner](../reports/lunar-budget-20261125/README.md)

## Contract

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `runId` | Contract version and local per-run identifier. Re-exporting one workbench run keeps its ID. |
| `host`, `backend`, `source`, `artifact` | Execution host, backend, checkout revision and dirty flag where available, plus codec artifact name and SHA-256. A CLI observes the checkout at report time. The browser records the core artifact digests generated into the static build manifest. |
| `input`, `output` | File name, format, known byte count, digest and optional provenance. `retained` states whether the host kept the output. `complete` states whether that retained artifact finalized. A discard sink can report the processed bytes with both flags false. |
| `frame` | Accepted dimensions, precision, effective MAXVAL and NEAR in integer samples. Version 1 covers the current one-component, one-scan, ILV=0, Pt=0, unmapped profile. |
| `stages` | Encode, decode and compare have separate results: `not_run`, `incomplete`, `passed`, `failed` or `cancelled`. An incomplete stage started without a conclusive result. |
| `samples` | Total, actual samples compared with the original, observed maximum absolute sample error and declared bound. A passing comparison covers every sample. NEAR=0 requires sample equality. |
| `reference` | Independent reference execution, name and version for this run. The normal report paths above set `status: "not_run"`. Historical CharLS evidence remains linked to its own run and revision. |
| `status`, `error` | Overall terminal result and diagnostic. An unsupported-feature diagnostic stops validation at the identified feature, leaving the rest of the codestream unverified. |
| `stream` | Decoded rows if observed, rows actually delivered to a host sink or preview, provisional rows at termination, first-row counters, strict EOI/EOF status and trailing policy. Browser rows remain provisional until successful output close. |
| `timing`, `memory`, `limits` | The timing boundary text describes what was measured. Core array payload, bridge peak and input/output peaks have separate scopes. Last output queue bytes describe the latest observed event, which may precede failure or cancellation. Host retained output is tracked separately. |
| `physical`, `unexecuted` | Physical error values require verified provenance. The latter names omitted stages and hash operations. `null` means unavailable. Zero is a measured or defined zero for the stated scope. |

Browser SHA-256 reads each eligible Blob once, up to 4 MiB, outside job timing. Buffered downloads and input files within the cap can be hashed. Direct file sinks and discarded outputs have no browser digest. For larger inputs use the streaming file CLI to capture a fingerprint. Keep the input and any downloaded artifact with the report. SHA-256 binds bytes to results. The digest supplies no certification or measurement accuracy guarantee.

See [current scope](SCOPE.md), [payload accounting](ARCHITECTURE.md) and the [workbench handoff](SCIENTIFIC_WORKBENCH_HANDOFF.md).
