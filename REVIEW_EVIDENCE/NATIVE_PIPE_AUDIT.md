# Native decode core-first delivery

The review probe uses a 1 × 4, 8-bit, NEAR=0 all-zero stream. Its entropy byte is `f0`, followed by the two-byte EOI marker. The probe sends the entropy byte while keeping the input open, then sends EOI after a one-second observation window.

The rc.1 binary was built in Ubuntu 22.04 WSL2 with Moon `0.1.20261119`, clang 14, and SHA-256 `ec9239a16916da98a0ee428c1fb6bbef5a34af89f6df9f98ccce505d0af76967`. `--require-eager` failed with `rowsBeforeEoi=1` and `rowsAfterEoi=3`.

The first fix changes only `cmd/moonjls/main.mbt`. After a row event, the host tries the decoder again with the exhausted input slice. It refills only after the decoder returns `NeedInput`. The fixed binary SHA-256 is `267837ca5c3015adf1637a322bf27a8ab96699ff9c9e2ee9b3e1166539a7ed6c`. The same probe passed with `rowsBeforeEoi=4` and `rowsAfterEoi=0`.

Reproduce from the repository root in WSL or Linux after building the native CLI:

```sh
moon build cmd/moonjls --target native --release
python3 REVIEW_EVIDENCE/audit_native_pipe.py _build/native/release/build/cmd/moonjls/moonjls.exe --require-eager
```

The probe checks final samples and does not treat pre-EOI rows as completion. Existing validation still covers truncated EOI, nonzero padding, strict trailing data, slow sinks and exact consumed positions.
