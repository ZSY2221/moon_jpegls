"""Measure bounded stream resource behavior and fixed-precision coding effects."""

import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path
import platform
from statistics import median
import subprocess
import sys
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


RESOURCE_WIDTH = 512
RESOURCE_HEIGHTS = (64, 512, 4096)


def write_report(path, contents):
    path.write_text(json.dumps(contents, indent=2) + "\n", encoding="utf8", newline="\n")


def describe(path, base):
    data = path.read_bytes()
    return {"path": path.relative_to(base).as_posix(), "bytes": len(data), "sha256": sha256(data).hexdigest()}


def resource_fixtures(output, heights, near_values):
    fixtures = []
    for height in heights:
        y, x = np.indices((height, RESOURCE_WIDTH))
        pixels = (x * 173 + y * 47 + ((x ^ y) & 31) * 3).astype(np.uint16)
        stem = f"resource-{RESOURCE_WIDTH}x{height}"
        source = output / f"{stem}.raw"
        save_raw(source, pixels)
        for near in near_values:
            coded_stream = output / (f"{stem}.jls" if near == 0 else f"{stem}-near{near}.jls")
            coded_stream.write_bytes(encode_native(pixels, 16, near))
            restored = decode_native(coded_stream.read_bytes())
            reconstructed = output / f"{stem}-near{near}.reconstructed.raw"
            save_raw(reconstructed, restored)
            fixtures.append({
                "width": RESOURCE_WIDTH, "height": height, "bits": 16, "near": near,
                "sourceSamples": describe(source, output),
                "encoded": describe(coded_stream, output),
                "reconstructedSamples": describe(reconstructed, output),
                "maxError": check_samples(stem, restored, pixels, near),
            })
    write_report(output / "resource-fixtures.json", {
        "sampleFormula": "(x*173 + y*47 + ((x^y)&31)*3) & 65535",
        "sampleRepresentation": "row-major uint16 little endian",
        "oracle": {"wheel": codecs.__version__, "jpegls": codecs.jpegls_version()},
        "fixtures": fixtures,
    })
    return fixtures


def resources(output, warmup, repeats):
    fixture_records = resource_fixtures(output, RESOURCE_HEIGHTS, (0,))
    records = []
    for fixture in fixture_records:
        height = fixture["height"]
        path = output / fixture["encoded"]["path"]
        for backend in ("js", "wasm-gc"):
            for operation in ("encode", "decode"):
                scenarios = [("normal", 4096, 4096), ("minimum", 1, 1)]
                if height == RESOURCE_HEIGHTS[1]:
                    scenarios.append(("paused-sink", 4096, 1))
                for name, in_chunk, out_chunk in scenarios:
                    args = ["resource", backend, operation, path, RESOURCE_WIDTH, height, in_chunk, out_chunk]
                    if name == "paused-sink":
                        args.append("pause")
                    isolated = node(*args)
                    steady = node(*args, "--warmup", warmup, "--repeats", repeats)
                    records.append({
                        "scenario": name, "fixture": fixture, "steady": steady,
                        "isolatedColdProcess": isolated,
                    })
        print(f"Resource trials finished at {RESOURCE_WIDTH}x{height}", flush=True)
    return {
        "timingBoundary": {
            "driverElapsedMs": "SDK streaming driver, source and sink callbacks, checksum and output validation; excludes module load and source setup.",
            "trialWallMs": "Wall time around streaming driver and final validation and closure, excluding module load and source setup.",
            "steady": "One Node process and one loaded core per scenario; a new stream and source per sample.",
            "isolatedColdProcess": "One fresh Node process and one trial per scenario for cold load and process peak RSS; OS caches are not cleared.",
        },
        "records": records,
    }


def measure(call, warmup, repeats):
    warmup_ms, samples_ms = [], []
    value = None
    for index in range(warmup + repeats):
        started = perf_counter_ns()
        value = call()
        (warmup_ms if index < warmup else samples_ms).append((perf_counter_ns() - started) / 1_000_000)
    center = median(samples_ms)
    return value, {
        "warmupMs": warmup_ms, "samplesMs": samples_ms,
        "summaryMs": {
            "median": center, "min": min(samples_ms), "max": max(samples_ms),
            "mad": median(abs(value - center) for value in samples_ms),
        },
    }


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
            subprocess.run([sys.executable, "scripts/fetch_lunar_fixture.py", str(lola)], cwd=ROOT, timeout=120, check=True)
        pixels, maximum = pgm_samples(lola)
        if maximum != 65535 or pixels.shape != (720, 1440):
            raise ValueError("unexpected NASA LOLA fixture dimensions or precision")
        yield "lola-moon", pixels.astype(np.uint16), 16, "public-domain-lunar-altimetry"


def effect(output, warmup, repeats, real):
    cases = []
    comparison = {}
    for name, pixels, bits, group in fixtures(real):
        pixels = np.ascontiguousarray(pixels, dtype=np.uint16)
        source = output / f"{name}.raw"
        save_raw(source, pixels)
        cases.append({"name": name, "width": pixels.shape[1], "height": pixels.shape[0], "bits": bits, "group": group,
                      "minSample": int(pixels.min()), "maxSample": int(pixels.max()), "sourceSamples": describe(source, output)})
        png, encode = measure(lambda: codecs.png_encode(pixels, level=6), warmup, repeats)
        restored, decode = measure(lambda: codecs.png_decode(png), warmup, repeats)
        png_report = {"bytes": len(png), "maxError": check_samples(name, restored, pixels, 0),
                      "encode": encode, "decode": decode,
                      "storedBits": png[24], "effectiveBits": bits}
        for near in (0, 3):
            record = {"png": png_report}
            if bits == 16:
                jls, encode = measure(lambda: encode_native(pixels, bits, near), warmup, repeats)
                restored, decode = measure(lambda: decode_native(jls), warmup, repeats)
                record["charls-native-wheel"] = {"bytes": len(jls), "maxError": check_samples(name, restored, pixels, near),
                                                  "encode": encode, "decode": decode}
            comparison[name, near] = record
    write_report(output / "manifest.json", cases)
    external = node("effect", output, warmup, repeats)
    for item in external["records"]:
        item.update(comparison[item["name"], item["near"]])
    external["nativeWheel"] = codecs.jpegls_version()
    external["pngBaseline"] = codecs.png_version()
    external["nativeComparable"] = False
    external["nativeTimingBoundary"] = "Separate Python/NumPy complete-result API wall time, excluding input loading and external checks."
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
                              "sha256": sha256(content).hexdigest(),
                              "gzipBytes": len(gzip.compress(content, compresslevel=9, mtime=0))})
        report[group] = {"artifacts": artifacts, "bytes": sum(item["bytes"] for item in artifacts),
                         "gzipBytes": sum(item["gzipBytes"] for item in artifacts)}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=EVIDENCE / "benchmark")
    parser.add_argument("--mode", choices=["all", "resource", "effect", "fixtures"], default="all",
                        help="fixtures generates the fixed 512x4096 NEAR=0 and NEAR=3 browser inputs without measuring")
    parser.add_argument("--warmup", type=int, default=2, help="pre-run count per steady resource and complete-result scenario")
    parser.add_argument("--repeats", type=int, default=5, help="formal measured count per steady resource and complete-result scenario")
    parser.add_argument("--real-data", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error("--repeats must be between 1 and 10")
    if not 0 <= args.warmup <= 10:
        parser.error("--warmup must be between 0 and 10")
    verify_version()
    output = args.directory.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.mode == "fixtures":
        resource_fixtures(output, (RESOURCE_HEIGHTS[-1],), (0, 3))
        print(f"Browser fixtures written to {output}")
        return
    report = {
        "schemaVersion": 2, "seed": SEED, "platform": platform.platform(),
        "python": platform.python_version(), "warmup": args.warmup, "repeats": args.repeats,
        "realData": args.real_data,
        "runnerRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "mooncVersion": subprocess.check_output(["moon", "version", "--all"], cwd=ROOT, text=True).splitlines()[:2],
        "sdkArtifactSizes": package_sizes(),
    }
    if args.mode in ("all", "effect"):
        report["effect"] = effect(output, args.warmup, args.repeats, args.real_data)
    if args.mode in ("all", "resource"):
        report["resource"] = resources(output, args.warmup, args.repeats)
    report_path = output / "benchmark.json"
    write_report(report_path, report)
    print(f"Benchmark evidence written to {report_path}")


if __name__ == "__main__":
    main()
