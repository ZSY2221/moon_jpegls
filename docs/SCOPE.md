# JPEG-LS support scope

The implementation targets the single-component procedures and interchange format of ITU-T T.87 Annexes A and C. See the [ITU recommendation and normative text](https://www.itu.int/rec/T-REC-T.87-199806-I/en).

| Field | Scope |
| --- | --- |
| Image | One frame, one component, one scan, ILV=0, known dimensions in 1–65535 and subject to caller limits |
| Coded sample precision and MAXVAL | 8/255, 12/4095, 16/65535 |
| Sample storage | Core uses unsigned values in MoonBit `Int` slots. Raw and JS adapters use 8-bit or 16-bit containers. A 16-bit container can hold 12-bit samples. |
| NEAR | 0, 1, 2, 3, measured in coded sample units |
| Entropy | Regular mode, run mode, run interruption and JPEG-LS one-bit stuffing |
| Markers | SOI, SOF55, SOS and EOI. APPn and COM before SOF55 or SOS are skipped under a cumulative budget. |
| Preset | LSE ID 1 with absent, zero or explicit default values. Valid custom settings return `UnsupportedFeature`. |
| Beyond scope | Other precisions, custom presets, mapping tables, restart intervals, DNL, extended dimensions, additional scans, multiple components, Part 2, DICOM container parsing |
| Targets | Native, Wasm GC and JS. See `VALIDATION.md` for executed checks. |

The streaming decoder returns the exact position after EOI. A host can reject trailing bytes or use the position to split a larger input. The whole-image decoder requires one complete frame. Samples delivered before EOI are provisional until `Done`.
