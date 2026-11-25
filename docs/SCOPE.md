# JPEG-LS support scope

MoonJLS implements the single-component exchange format in ITU-T T.87 Annexes A and C. The project targets the full JPEG-LS Part 1 codec and data-format capabilities in ITU-T T.87 (06/1998) / ISO/IEC 14495-1. [Capability matrix and acceptance plan](T87_CONFORMANCE_PLAN.md) · [Compatibility roadmap](ROADMAP.md)

| Field | Current M2 scope |
| --- | --- |
| Image | One frame, one component, one scan, ILV=0, Pt=0. Known dimensions in 1–65,535, subject to caller limits. |
| Coded precision and MAXVAL | P=2–16. MAXVAL defaults to `2^P−1`; explicit values can range from 1 through that default. |
| NEAR | Integer `0..min(255, floor(MAXVAL/2))`, measured in original unsigned sample units for the supported profile. |
| Presets | LSE1 MAXVAL, T1/T2/T3 and RESET. Decode accepts implicit defaults, zero fields and legal explicit parameters. The last applicable LSE1 replaces the preceding one. Encoder output uses explicit resolved values when it writes LSE1. |
| Sample storage | Core uses unsigned integer values in MoonBit `Int` slots. Native raw stores one byte per sample through 8 coded bits and two at 9–16 coded bits. PGM uses its actual MAXVAL to determine sample width and stores pairs big-endian. SDK input and output use `Uint16Array` at all coded precisions. |
| Entropy | Regular mode, run mode, run interruption and JPEG-LS one-bit stuffing. |
| Markers | SOI, SOF55, LSE1, SOS and EOI. APPn and COM before SOF55 or SOS are skipped under a cumulative budget. |
| Planned Part 1 capabilities | Multiple components and scans, mixed scan layouts, interleave, sampling, point transforms, mapping tables and continuations, abbreviated image and table formats, restart intervals, DNL, extended dimensions and remaining marker syntax. |
| Separate extensions | T.870 Part 2 and DICOM container parsing. |
| Backends | Native, Wasm GC and JS. |

MoonBit keeps `Frame` geometry, P and NEAR compatible with its grayscale entry points. `Frame::maxval()` gives the default full-scale value. Use the resolved `Preset` for the active MAXVAL and thresholds. On decode, the streaming session and `decode_with_preset` expose the parameters in force at SOS. [Public API](API.md)

The streaming decoder returns the exact position after EOI. Hosts can reject trailing bytes or use that position for framing. The whole-image decoder requires one complete frame. Samples delivered before EOI are provisional until `Done`.

Each backend passed Annex E E.2-9 through E.2-12 in both directions. E.2-1 through E.2-8 exercised the current multicomponent rejection boundary. The broader numeric parameter matrix and the original 640 full-range configurations have separate evidence. [Annex E results](CONFORMANCE_RESULTS.md) · [Machine-readable matrix](../tests/conformance/manifest.json) · [Validation](VALIDATION.md)
