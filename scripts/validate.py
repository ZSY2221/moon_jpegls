"""Prepare bounded interop cases and compare MoonJLS results with native CharLS."""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np

from corpus import CHARLS, CONFORMANCE, CONFORMANCE_HASHES, EVIDENCE, ROOT, SEED, TOOLS, download, fixtures, pgm_samples, save_raw
from oracle import decode_native, encode_native, read_raw, verify_version


def check_samples(name, output, expected, tolerance):
    expected = expected.ravel()
    output = output.ravel()
    if output.shape != expected.shape:
        raise AssertionError(f"{name}: sample count {output.size} != {expected.size}")
    delta = np.abs(output.astype(np.int32) - expected.astype(np.int32))
    outliers = np.flatnonzero(delta > tolerance)
    if outliers.size:
        index = int(outliers[0])
        raise AssertionError(f"{name}: sample {index}, {int(output[index])} vs {int(expected[index])}, limit {tolerance}")
    return int(delta.max(initial=0))


def near_matrix_fixtures(bits):
    maximum = (1 << bits) - 1
    width, height = 31, 9
    x = np.arange(width)
    rng = np.random.Generator(np.random.PCG64(SEED + bits))
    base = rng.integers(0, maximum + 1, (height, width), dtype=np.uint16)
    base[0] = 0
    base[1] = np.where(x < 21, 0, maximum)
    base[2] = x % 2 * maximum
    base[3] = x * maximum // (width - 1)
    base[4] = np.where(x < 16, maximum, 0)
    for near in range(min(255, maximum // 2) + 1):
        pixels = base.copy()
        edges = [0, max(0, near - 1), near, near + 1, maximum - near - 1, maximum - near, maximum]
        pixels[5] = np.resize(edges, width)
        yield "near-matrix", near, pixels


def prepare(directory, with_conformance, match, near_matrix):
    cases = []
    inputs = []
    for bits in (8, 12, 16):
        images = near_matrix_fixtures(bits) if near_matrix else (
            (pattern, near, pixels) for pattern, pixels in fixtures(bits) for near in range(4)
        )
        for pattern, near, pixels in images:
            name = f"b{bits}-n{near}-{pattern}"
            if match and match not in name:
                continue
            case = {"name": name, "width": pixels.shape[1], "height": pixels.shape[0], "bits": bits, "near": near}
            if near_matrix and bits == 16:
                case["charlsWasmImplicit"] = True
            raw = directory / f"{name}.raw"
            save_raw(raw, pixels)
            inputs.append(raw)
            if bits != 12:
                native = encode_native(pixels, bits, near)
                check_samples(name, decode_native(native), pixels, near)
                reference = directory / f"{name}.native.jls"
                reference.write_bytes(native)
                inputs.append(reference)
            cases.append(case)

    official = []
    if with_conformance:
        original = TOOLS / "conformance" / "test16.pgm"
        download(original, CONFORMANCE + original.name, 140_000, CONFORMANCE_HASHES[original.name])
        inputs.append(original)
        pixels, maximum = pgm_samples(original)
        for fixture, near in [("t16e0.jls", 0), ("t16e3.jls", 3)]:
            stream = download(TOOLS / "conformance" / fixture, CONFORMANCE + fixture, 140_000, CONFORMANCE_HASHES[fixture])
            reconstructed = decode_native(stream)
            check_samples(fixture, reconstructed, pixels, near)
            save_raw(directory / f"{fixture}.raw", reconstructed)
            (directory / fixture).write_bytes(stream)
            inputs.extend((directory / fixture, directory / f"{fixture}.raw"))
            official.append({"name": fixture, "expected": "valid", "near": near, "sourceMaximum": maximum})
        fixture = "t8nde0.jls"
        stream = download(TOOLS / "conformance" / fixture, CONFORMANCE + fixture, 140_000, CONFORMANCE_HASHES[fixture])
        save_raw(directory / f"{fixture}.raw", decode_native(stream))
        (directory / fixture).write_bytes(stream)
        inputs.extend((directory / fixture, directory / f"{fixture}.raw"))
        official.append({"name": fixture, "expected": "valid", "near": 0, "bits": 8, "sourceMaximum": 255})
        for fixture in ["t8c0e0.jls", "t8c1e0.jls", "t8c2e0.jls", "t8sse0.jls"]:
            stream = download(TOOLS / "conformance" / fixture, CONFORMANCE + fixture, 140_000, CONFORMANCE_HASHES[fixture])
            (directory / fixture).write_bytes(stream)
            inputs.append(directory / fixture)
            official.append({"name": fixture, "expected": "unsupported"})
    if not cases:
        raise ValueError("no matching image cases")
    try:
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        tracked_diff = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, text=True).splitlines()
    except (OSError, subprocess.CalledProcessError):
        revision, tracked_diff = "unavailable", []
    fixture_hashes = {}
    for path in inputs:
        with path.open("rb") as file:
            fixture_hashes[path.name] = file_digest(file, "sha256").hexdigest()
    manifest = {"seed": SEED, "charlsNativeCommit": CHARLS, "revision": revision, "trackedDiff": tracked_diff,
                "fixtureSha256": fixture_hashes,
                "command": [str(Path(sys.executable)), *sys.argv], "cases": cases, "conformance": official}
    if near_matrix:
        manifest["nearMatrix"] = True
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf8")
    return manifest


def check_native(directory, suite, backends, native_cli):
    checks = 0
    maximum_errors = defaultdict(int)
    case_results = []
    near_matrix = suite.get("nearMatrix", False)
    for case in suite["cases"]:
        name, near = case["name"], case["near"]
        pixels = read_raw(directory / f"{name}.raw")
        source_names = ["charls-wasm"]
        if case.get("charlsWasmImplicit"):
            source_names.append("charls-wasm-implicit")
        if case["bits"] != 12:
            source_names.append("native")
        decoders = backends + (["native-cli"] if native_cli else [])
        streams = {}
        for source in source_names + decoders:
            stream = (directory / f"{name}.{source}.jls").read_bytes()
            reconstruction = decode_native(stream)
            max_error = check_samples(f"{name}/{source}/native error", reconstruction, pixels, near)
            matched = []
            for backend in decoders:
                if source == "native-cli" and backend != "native-cli":
                    continue
                backend_reconstructed = read_raw(directory / f"{name}.{source}.{backend}.raw")
                check_samples(f"{name}/{source}/{backend} same-stream comparison", backend_reconstructed, reconstruction, 0)
                observed = check_samples(f"{name}/{source}/{backend} precision", backend_reconstructed, pixels, near)
                key = f"{case['bits']}/{near}"
                maximum_errors[key] = max(maximum_errors[key], observed)
                matched.append(backend)
                checks += 1
            if near_matrix:
                streams[source] = {"bytes": len(stream), "sha256": sha256(stream).hexdigest(),
                                   "reconstructionSha256": sha256(reconstruction.tobytes()).hexdigest(),
                                   "maxAbsoluteError": max_error, "sameStreamDecoders": matched}
        if near_matrix:
            case_results.append({**case, "inputSha256": suite["fixtureSha256"][f"{name}.raw"], "streams": streams})
    result = {"nativeOracleSameStreamComparisons": checks, "maxAbsoluteErrorByBitsAndNear": dict(maximum_errors)}
    if near_matrix:
        filename = "near-matrix-cases.json"
        (directory / filename).write_text(json.dumps(case_results, indent=2) + "\n", encoding="utf8")
        result["nearMatrixCases"] = filename
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--conformance", action="store_true")
    parser.add_argument("--near-matrix", action="store_true", help="Check every legal NEAR value at 8, 12 and 16 bits")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--match", default="", help="Filter base image IDs to reproduce a failure")
    parser.add_argument("--backend", action="append", choices=["js", "wasm-gc"])
    parser.add_argument("--native-exe", type=Path, help="Release MoonJLS native CLI executable")
    parser.add_argument("--native-wsl", metavar="DISTRO", help="Run the native CLI inside this WSL distribution")
    args = parser.parse_args()
    verify_version()
    directory = (args.directory or EVIDENCE / ("validation-near-matrix" if args.near_matrix else "validation")).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    suite = prepare(directory, args.conformance, args.match, args.near_matrix)
    print(f"Prepared {len(suite['cases'])} base cases and {len(suite['conformance'])} conformance streams in {directory}", flush=True)
    if args.prepare_only:
        return
    backends = args.backend or ["js", "wasm-gc"]
    command = ["node", "scripts/interop.mjs", str(directory), *backends]
    try:
        proc = subprocess.run(command, cwd=ROOT, timeout=360 if args.near_matrix else 180,
                              text=True, encoding="utf8", capture_output=True, check=True)
        summary = json.loads(proc.stdout)
        if args.native_exe:
            native_exe = args.native_exe.resolve()
            if args.native_wsl:
                command = ["wsl", "-d", args.native_wsl, "--exec", "python3", "scripts/native_validate.py",
                           directory.relative_to(ROOT).as_posix(), native_exe.relative_to(ROOT).as_posix(), *backends]
            else:
                command = [sys.executable, "scripts/native_validate.py", str(directory), str(native_exe), *backends]
            proc = subprocess.run(command, cwd=ROOT, timeout=900 if args.near_matrix else 240,
                                  text=True, encoding="utf8", errors="replace",
                                  capture_output=True, check=True)
            summary.update(json.loads(proc.stdout))
        summary.update(check_native(directory, suite, backends, args.native_exe is not None))
    except (AssertionError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        failure = {"command": command, "invocation": [str(Path(sys.executable)), *sys.argv], "seed": SEED,
                   "revision": suite["revision"], "trackedDiff": suite["trackedDiff"], "error": str(error),
                   "stderr": getattr(error, "stderr", None), "stdout": getattr(error, "stdout", None)}
        failure_tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        (directory / f"failed-run-{failure_tag}.json").write_text(json.dumps(failure, indent=2), encoding="utf8")
        print(f"Failure artifacts retained at {directory}", file=sys.stderr)
        if getattr(error, "stderr", None):
            print(error.stderr, file=sys.stderr)
        raise
    summary["sourceRevision"] = suite["revision"]
    summary["trackedDiff"] = suite["trackedDiff"]
    summary["seed"] = SEED
    summary["backends"] = backends + (["native"] if args.native_exe else [])
    summary["python"] = sys.version.split()[0]
    summary["nativeOracle"] = "imagecodecs 2026.11.11 / CharLS 2.4.5"
    summary["runtime"] = {"platform": sys.platform, "cpuCount": os.cpu_count()}
    (directory / "report.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf8", newline="\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
