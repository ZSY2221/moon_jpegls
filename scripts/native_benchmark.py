"""Time native MoonJLS pipeline and native CharLS/libpng in one Linux runtime."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
from statistics import median
import subprocess
import sys
from time import perf_counter_ns


def measure(call, repeats):
    timings = []
    value = None
    for _ in range(repeats + 1):
        started = perf_counter_ns()
        value = call()
        timings.append((perf_counter_ns() - started) / 1_000_000)
    return value, timings[0], median(timings[1:])


def cli(binary, args, data):
    proc = subprocess.run([str(binary), *map(str, args)], input=data, timeout=60, capture_output=True, check=True)
    return proc.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--deps", type=Path, help="Directory with prebuilt NumPy and imagecodecs wheel installs")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error("--repeats must be between 1 and 10")
    if sys.byteorder != "little":
        parser.error("native benchmark requires a little-endian host")
    if args.deps:
        sys.path.insert(0, str(args.deps.resolve()))

    cold = perf_counter_ns()
    import imagecodecs as codecs
    import numpy as np

    from oracle import decode_native, encode_native, verify_version
    from validate import check_samples

    cold_ms = (perf_counter_ns() - cold) / 1_000_000
    verify_version()
    directory = args.directory.resolve()
    binary = args.binary.resolve()
    cases = json.loads((directory / "manifest.json").read_text(encoding="utf8"))
    result = []
    for case in cases:
        name, width, height, bits = (case[key] for key in ("name", "width", "height", "bits"))
        raw = (directory / f"{name}.raw").read_bytes()
        pixels = np.frombuffer(raw, dtype="<u2").reshape((height, width))
        png, ef, em = measure(lambda: codecs.png_encode(pixels, level=6), args.repeats)
        rebuilt, df, dm = measure(lambda: codecs.png_decode(png), args.repeats)
        png_report = {"bytes": len(png), "maxError": check_samples(name, rebuilt, pixels, 0),
                      "encodeFirstMs": ef, "decodeFirstMs": df, "encodeMedianMs": em, "decodeMedianMs": dm}
        for near in [0, 3]:
            command = ["encode", width, height, bits, near, "-", "-", "raw-le", 8192]
            jls, ef, em = measure(lambda: cli(binary, command, raw), args.repeats)
            command = ["decode", "-", "-", "raw-le", 8192]
            reconstructed, df, dm = measure(lambda: cli(binary, command, jls), args.repeats)
            decoded = np.frombuffer(reconstructed, dtype="<u2").reshape((height, width))
            check_samples(name, decoded, decode_native(jls), 0)
            record = {**case, "near": near, "pngNativeApi": png_report,
                      "moonjlsNativeCli": {"bytes": len(jls), "maxError": check_samples(name, decoded, pixels, near),
                                           "encodeFirstMs": ef, "decodeFirstMs": df, "encodeMedianMs": em, "decodeMedianMs": dm}}
            if bits == 16:
                alternate, ef, em = measure(lambda: encode_native(pixels, bits, near), args.repeats)
                decoded, df, dm = measure(lambda: decode_native(alternate), args.repeats)
                record["charlsNativeApi"] = {"bytes": len(alternate), "maxError": check_samples(name, decoded, pixels, near),
                                             "encodeFirstMs": ef, "decodeFirstMs": df, "encodeMedianMs": em, "decodeMedianMs": dm}
            result.append(record)
    report = {"platform": platform.platform(), "python": platform.python_version(), "wheel": codecs.__version__,
              "charls": codecs.jpegls_version(), "png": codecs.png_version(), "wheelImportMs": cold_ms,
              "nativeBinarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "repeats": args.repeats,
              "records": result}
    (directory / "native-wsl.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"cases": len(result), "charls": report["charls"], "python": report["python"]}))


if __name__ == "__main__":
    main()
