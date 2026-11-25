"""Batch assertions for the native CLI (stdlib only, runs inside WSL or Linux)."""

import argparse
from array import array
import json
from pathlib import Path
import subprocess
import sys


def assert_raw(actual, expected, label):
    if actual == expected:
        return
    if len(actual) != len(expected):
        raise AssertionError(f"{label}: reconstructed byte count {len(actual)} vs {len(expected)}")
    got, want = array("H", actual), array("H", expected)
    index = next(i for i in range(len(got)) if got[i] != want[i])
    raise AssertionError(f"{label}: first sample difference at index {index}, {got[index]} vs {want[index]}")


def raw16(raw, bits):
    if bits > 8:
        return raw
    result = bytearray(2 * len(raw))
    result[::2] = raw
    return bytes(result)


def run(binary, *args, input_data=None):
    try:
        return subprocess.run([str(binary), *map(str, args)], input=input_data, timeout=30, capture_output=True, check=True)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"{error.cmd}: status {error.returncode}, {error.stderr.decode(errors='replace')}") from error


def validate(directory, binary, backends):
    suite = json.loads((directory / "manifest.json").read_text(encoding="utf8"))
    count = {"nativeCLIImages": 0, "nativeCLIEncodeQuantumMatches": 0, "nativeCrossBackendBytes": 0,
             "nativeCLISameStreamComparisons": 0, "nativeCLIPgmPipeChecks": 0,
             "nativeCLIOfficialPass": 0, "nativeCLIOfficialUnsupported": 0}
    near_matrix = suite.get("nearMatrix", False)
    if near_matrix:
        count["nativeCLIDecodeQuantumMatches"] = 0
    for frame in suite["cases"]:
        name, width, height, bits, near = [frame[key] for key in ("name", "width", "height", "bits", "near")]
        pixels = (directory / f"{name}.raw").read_bytes()
        raw = pixels[::2] if bits == 8 else pixels
        baseline = run(binary, "encode", width, height, bits, near, "-", "-", "raw-le", 4096, input_data=raw).stdout
        (directory / f"{name}.native-cli.jls").write_bytes(baseline)
        limited = run(binary, "encode", width, height, bits, near, "-", "-", "raw-le", 1, input_data=raw).stdout
        if limited != baseline:
            (directory / f"{name}.native-cli.split.jls").write_bytes(limited)
            raise AssertionError(f"native CLI disagrees across chunk sizes: {name}")
        count["nativeCLIEncodeQuantumMatches"] += 1
        for backend in backends:
            other = (directory / f"{name}.{backend}.jls").read_bytes()
            if baseline != other:
                raise AssertionError(f"native CLI / {backend} fixed policy stream bytes mismatch: {name}")
            count["nativeCrossBackendBytes"] += 1
        sources = ["charls-wasm", *backends, "native-cli"]
        if frame.get("charlsWasmImplicit"):
            sources.append("charls-wasm-implicit")
        if bits != 12:
            sources.append("native")
        for source in sources:
            filename = directory / f"{name}.{source}.jls"
            chunk = 1 if near_matrix or name.endswith("stuffing-runs") else 17
            got = run(binary, "decode", filename, "-", "raw-le", chunk).stdout
            if near_matrix and source == "charls-wasm":
                wide_chunk = run(binary, "decode", filename, "-", "raw-le", 4096).stdout
                assert_raw(raw16(wide_chunk, bits), raw16(got, bits), f"native decode quantum: {name}")
                count["nativeCLIDecodeQuantumMatches"] += 1
            reconstructed = raw16(got, bits)
            (directory / f"{name}.{source}.native-cli.raw").write_bytes(reconstructed)
            if source != "native-cli":
                expected = (directory / f"{name}.{source}.{backends[0]}.raw").read_bytes()
                assert_raw(reconstructed, expected, f"native decode {source}: {name}")
            count["nativeCLISameStreamComparisons"] += 1
        if name == "b16-n0-row":
            pgm = f"P5\n# endian and pipe\n{width} {height}\n65535\n".encode("ascii")
            be = bytearray(pixels)
            be[::2], be[1::2] = pixels[1::2], pixels[::2]
            encoded = run(binary, "encode-pgm", 0, "-", "-", 1, input_data=pgm + be).stdout
            assert encoded == baseline, "PGM and raw coding differ"
            pgm_out = run(binary, "decode", "-", "-", "pgm", 1, input_data=encoded).stdout
            assert pgm_out == f"P5\n{width} {height}\n65535\n".encode("ascii") + be, "PGM pipe endian mismatch"
            run(binary, "inspect", "-", 1, input_data=encoded)
            run(binary, "verify", "-", 1, input_data=encoded)
            count["nativeCLIPgmPipeChecks"] += 4
        count["nativeCLIImages"] += 1

    if near_matrix:
        invalid = directory / f"{backends[0]}-invalid-near-128.jls"
        trial = subprocess.run([str(binary), "verify", str(invalid), "1"], capture_output=True, timeout=30)
        assert trial.returncode != 0 and b"InvalidData" in trial.stderr, trial.stderr
        count["nativeCLINearBoundaryRejections"] = 1
        for bits, near in ((8, -1), (8, 128), (12, 256), (16, 256)):
            args = [str(binary), "encode", "1", "1", str(bits), str(near), "-", "-", "raw-le", "1"]
            trial = subprocess.run(args, input=b"", capture_output=True, timeout=30)
            assert trial.returncode != 0 and b"InvalidArgument" in trial.stderr, (bits, near, trial.stderr)
            count["nativeCLINearBoundaryRejections"] += 1

    for official in suite["conformance"]:
        path = directory / official["name"]
        if official["expected"] == "valid":
            expected = (directory / f"{official['name']}.raw").read_bytes()
            reconstructed = run(binary, "decode", path, "-", "raw-le", 23).stdout
            assert_raw(reconstructed, expected, path)
            count["nativeCLIOfficialPass"] += 1
        else:
            result = subprocess.run([str(binary), "verify", str(path), "23"], capture_output=True, timeout=30)
            assert result.returncode and b"UnsupportedFeature" in result.stderr, f"{path}: {result.stderr!r}"
            count["nativeCLIOfficialUnsupported"] += 1
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("binary", type=Path)
    parser.add_argument("backends", nargs="+")
    args = parser.parse_args()
    if sys.byteorder != "little":
        parser.error("native validation requires a little-endian host")
    print(json.dumps(validate(args.directory.resolve(), args.binary.resolve(), args.backends)))


if __name__ == "__main__":
    main()
