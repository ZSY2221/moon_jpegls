"""Measure bounded stream resource behavior and fixed-precision coding effects."""

import argparse
import gzip
import json
from pathlib import Path
import platform
from statistics import median
import subprocess
from time import perf_counter_ns

import imagecodecs as codecs
import numpy as np

from corpus import EVIDENCE, LILY_SHA256, LILY_URL, ROOT, SEED, TOOLS, benchmark_fixtures, download, pgm_samples, save_raw
from oracle import decode_native, encode_native, verify_version
from validate import check_samples


def node(*args, timeout=240):
    response = subprocess.run(["node", "scripts/bench_node.mjs", *map(str, args)], cwd=ROOT, timeout=timeout,
                              check=True, text=True, encoding="utf8", stdout=subprocess.PIPE)
    return json.loads(response.stdout)


def resources(output):
    width = 512
    heights = (64, 512, 4096)
    reports = []
    for height in heights:
        y, x = np.indices((height, width))
        pixels = (x * 173 + y * 47 + ((x ^ y) & 31) * 3).astype(np.uint16)
        path = output / f"resource-{width}x{height}.jls"
        path.write_bytes(encode_native(pixels, 16, 0))
        # Child processes are the measured portion. This fixture generation may allocate the complete array.
        for backend in ("js", "wasm-gc"):
            for operation in ("encode", "decode"):
                for name, in_chunk, out_chunk in [("normal", 4096, 4096), ("minimum", 1, 1)]:
                    trial = node("resource", backend, operation, path, width, height, in_chunk, out_chunk)
                    trial["scenario"] = name
                    reports.append(trial)
                if height == heights[1]:
                    trial = node("resource", backend, operation, path, width, height, 4096, 1, "pause")
                    trial["scenario"] = "paused-sink"
                    reports.append(trial)
        print(f"Resource trials finished at {width}x{height}", flush=True)
    return reports


def measure(call, repeats):
    timings = []
    value = None
    for _ in range(repeats + 1):
        started = perf_counter_ns()
        value = call()
        timings.append((perf_counter_ns() - started) / 1_000_000)
    return value, timings[0], median(timings[1:])


def fixtures(real):
    yield from benchmark_fixtures()
    if real:
        import tifffile

        path = TOOLS / "lily.tif"
        download(path, LILY_URL, 7_000_000, LILY_SHA256)
        volume = tifffile.imread(path)
        if volume.shape != (4, 922, 922) or volume.dtype != np.uint16:
            raise ValueError(f"unexpected microscopy TIFF layout: {volume.shape} {volume.dtype}")
        field = volume[1, 205:717, 205:717]
        yield "lily-channel-1-center", field, 12, "public-cc0-microscopy"

        lola = EVIDENCE / "real" / "lola.pgm"
        if not lola.exists():
            subprocess.run(["python", "scripts/fetch_lunar_fixture.py", str(lola)], cwd=ROOT, timeout=120, check=True)
        pixels, maximum = pgm_samples(lola)
        if maximum != 65535 or pixels.shape != (720, 1440):
            raise ValueError("unexpected NASA LOLA fixture dimensions or precision")
        yield "lola-moon", pixels.astype(np.uint16), 16, "public-domain-lunar-altimetry"


def effect(output, repeats, real):
    cases = []
    comparison = {}
    for name, pixels, bits, group in fixtures(real):
        cases.append({"name": name, "width": pixels.shape[1], "height": pixels.shape[0], "bits": bits, "group": group,
                      "minSample": int(pixels.min()), "maxSample": int(pixels.max())})
        pixels = np.ascontiguousarray(pixels, dtype=np.uint16)
        save_raw(output / f"{name}.raw", pixels)
        png, enc_first, enc_median = measure(lambda: codecs.png_encode(pixels, level=6), repeats)
        restored, dec_first, dec_median = measure(lambda: codecs.png_decode(png), repeats)
        png_report = {"bytes": len(png), "maxError": check_samples(name, restored, pixels, 0),
                      "encodeFirstMs": enc_first, "encodeMedianMs": enc_median,
                      "decodeFirstMs": dec_first, "decodeMedianMs": dec_median,
                      "storedBits": png[24], "effectiveBits": bits}
        for near in (0, 3):
            record = {"png": png_report}
            if bits == 16:
                jls, enc_first, enc_median = measure(lambda: encode_native(pixels, bits, near), repeats)
                restored, dec_first, dec_median = measure(lambda: decode_native(jls), repeats)
                record["charls-native-wheel"] = {"bytes": len(jls), "maxError": check_samples(name, restored, pixels, near),
                                                  "encodeFirstMs": enc_first, "encodeMedianMs": enc_median,
                                                  "decodeFirstMs": dec_first, "decodeMedianMs": dec_median}
            comparison[name, near] = record
    (output / "manifest.json").write_text(json.dumps(cases, indent=2), encoding="utf8")
    external = node("effect", output, repeats)
    for item in external["records"]:
        item.update(comparison[item["name"], item["near"]])
    external["nativeWheel"] = codecs.jpegls_version()
    external["pngBaseline"] = codecs.png_version()
    external["nativeComparable"] = False
    return external


def package_sizes():
    charls = TOOLS / "oracle-npm" / "node_modules" / "@team-charls" / "charls-wasm"
    groups = {
        "moonjls-js": [ROOT / "sdk/index.mjs", ROOT / "sdk/generated/core.mjs"],
        "moonjls-wasm-gc": [ROOT / "sdk/index.mjs", ROOT / "sdk/generated/core.wasm"],
        "charls-wasm": sorted([path for path in charls.iterdir() if path.suffix in (".js", ".wasm")]),
    }
    report = {}
    for group, paths in groups.items():
        artifacts = []
        for path in paths:
            content = path.read_bytes()
            artifacts.append({"name": str(path.relative_to(ROOT)).replace("\\", "/"), "bytes": len(content),
                              "gzipBytes": len(gzip.compress(content, compresslevel=9, mtime=0))})
        report[group] = {"artifacts": artifacts, "bytes": sum(item["bytes"] for item in artifacts),
                         "gzipBytes": sum(item["gzipBytes"] for item in artifacts)}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=EVIDENCE / "benchmark")
    parser.add_argument("--mode", choices=["all", "resource", "effect"], default="all")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--real-data", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error("--repeats must be between 1 and 10")
    verify_version()
    output = args.directory.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "seed": SEED, "platform": platform.platform(), "python": platform.python_version(), "repeats": args.repeats,
        "mooncBuild": "node sdk/build.mjs; release targets js and wasm-gc", "realData": args.real_data,
        "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "mooncVersion": subprocess.check_output(["moon", "version", "--all"], cwd=ROOT, text=True).splitlines()[:2],
        "sdkArtifactSizes": package_sizes(),
    }
    if args.mode in ("all", "effect"):
        report["effect"] = effect(output, args.repeats, args.real_data)
    if args.mode in ("all", "resource"):
        report["resource"] = resources(output)
    report_path = output / "benchmark.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8", newline="\n")
    print(f"Benchmark evidence written to {report_path}")


if __name__ == "__main__":
    main()
