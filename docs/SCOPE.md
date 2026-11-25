# JPEG-LS support scope

The current implementation covers a single-component profile of the procedures and interchange format in ITU-T T.87 Annexes A and C. The project targets complete JPEG-LS Part 1 codec and data-format capabilities in [ITU-T T.87 (06/1998)](https://www.itu.int/rec/T-REC-T.87-199806-I/en) / ISO/IEC 14495-1. See the [T.87 capability matrix and acceptance plan](T87_CONFORMANCE_PLAN.md) and the [compatibility roadmap](ROADMAP.md).

| Field | Scope |
| --- | --- |
| Image | One frame, one component, one scan, ILV=0, known dimensions in 1–65535 and subject to caller limits |
| Coded sample precision and MAXVAL | 8/255, 12/4095, 16/65535 |
| Sample storage | Core uses unsigned values in MoonBit `Int` slots. Raw and JS adapters use 8-bit or 16-bit containers. A 16-bit container can hold 12-bit samples. |
| NEAR | Integers 0–127 at 8 bits and 0–255 at 12 or 16 bits, in coded sample units. [640-configuration validation](../reports/review-near-20261125/README.md) |
| Entropy | Regular mode, run mode, run interruption and JPEG-LS one-bit stuffing |
| Markers | SOI, SOF55, SOS and EOI. APPn and COM before SOF55 or SOS are skipped under a cumulative budget. |
| Preset | LSE ID 1 with absent, zero or explicit default values. Valid custom settings return `UnsupportedFeature`. |
| Planned Part 1 capabilities | Other legal precisions, non-default MAXVAL and presets, multiple components and scans, interleave, sampling and point transforms, mapping and abbreviated formats, restart intervals, DNL, extended dimensions and remaining marker syntax |
| Separate extensions | T.870 Part 2 and DICOM container parsing |
| Targets | Native, Wasm GC and JS. See `VALIDATION.md` for executed checks. |

The streaming decoder returns the exact position after EOI. A host can reject trailing bytes or use the position to split a larger input. The whole-image decoder requires one complete frame. Samples delivered before EOI are provisional until `Done`.
