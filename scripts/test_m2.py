"""Grade M2 MoonJLS against the official HP/ITU reference and small T.87 vectors."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_SHA256 = "085285f0552ef0b6ebcf29bc5a6d3bc0d6bda0408e9f2f1c138be2e55200814f"
FIELDS = ("maxval", "t1", "t2", "t3", "reset")
BACKENDS = ("js", "wasm-gc", "native")
DEFAULT_CHUNK = 4096


def digest(data):
    return sha256(data).hexdigest()


def pack_samples(pixels, *, wide=True, big=False):
    if not wide:
        return bytes(pixels)
    return struct.pack((">" if big else "<") + f"{len(pixels)}H", *pixels)


def unpack_samples(data, *, wide=True, big=False):
    if not wide:
        return tuple(data)
    return struct.unpack((">" if big else "<") + f"{len(data) // 2}H", data)


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def run(command, *, cwd=ROOT, input_data=None, check=True, timeout=120):
    result = subprocess.run([str(arg) for arg in command], cwd=cwd, input=input_data, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{command[0]} {command[1:]} exited {result.returncode}: "
                           f"{(result.stderr + result.stdout[-800:]).decode(errors='replace')}")
    return result


def check_pixels(output, expected, maximum, label):
    assert len(output) == len(expected), f"{label}: length {len(output)} != {len(expected)}"
    errors = map(lambda pair: abs(pair[0] - pair[1]), zip(output, expected))
    peak = 0
    for i, delta in enumerate(errors):
        assert delta <= maximum, f"{label}: sample {i} {output[i]} != {expected[i]} within {maximum}"
        peak = max(peak, delta)
    return peak


def markers(stream):
    assert stream[:2] == bytes.fromhex("ffd8")
    pos = 2
    while pos + 4 <= len(stream):
        assert stream[pos] == 255, f"Expected a marker at {pos}"
        code = stream[pos + 1]
        length = int.from_bytes(stream[pos + 2:pos + 4], "big")
        end = pos + length + 2
        assert length >= 2 and end <= len(stream)
        yield code, pos, end, stream[pos + 4:end]
        if code == 0xDA:
            return
        pos = end
    raise AssertionError("Missing SOS")


def lse(fields):
    return bytes.fromhex("fff8") + struct.pack(">HB5H", 13, 1, *fields)


def inspect_header(stream):
    preset = (0, 0, 0, 0, 0)
    for code, _, _, data in markers(stream):
        if code == 0xF7:
            bits, height, width = struct.unpack(">BHH", data[:5])
            assert data[5:] == bytes((1, 1, 0x11, 0))
        elif code == 0xF8 and data[0] == 1:
            preset = struct.unpack(">5H", data[1:])
        elif code == 0xDA:
            assert data[:3] == bytes((1, 1, 0)) and data[4:] == bytes((0, 0))
            frame = {"bits": bits, "width": width, "height": height, "near": data[3]}
            return frame, preset
    raise AssertionError("Missing scan preview")


def rewrite_header(stream, *, bits=None, presets=None, before_frame=False):
    output = bytearray(stream[:2])
    if before_frame:
        output.extend(b"".join(map(lse, presets)))
    for code, pos, end, data in markers(stream):
        if code == 0xF8 and data[0] == 1 and presets is not None:
            continue
        if code == 0xF7 and bits is not None:
            output.extend(stream[pos:pos + 4] + bytes((bits,)) + stream[pos + 5:end])
            continue
        if code == 0xDA:
            if presets is not None and not before_frame:
                output.extend(b"".join(map(lse, presets)))
            output.extend(stream[pos:])
            return bytes(output)
        output.extend(stream[pos:end])
    raise AssertionError("Missing SOS")


def defaults(maxval, near):
    if maxval >= 128:
        factor = (min(maxval, 4095) + 128) // 256
        a, b, c = (factor + 2 + 3 * near, 4 * factor + 3 + 5 * near, 17 * factor + 4 + 7 * near)
    else:
        factor = 256 // (maxval + 1)
        a, b, c = (max(2, 3 // factor + 3 * near), max(3, 7 // factor + 5 * near), max(4, 21 // factor + 7 * near))

    def clamp(candidate, lower):
        return candidate if lower <= candidate <= maxval else lower

    t1 = clamp(a, near + 1)
    t2 = clamp(b, t1)
    return (t1, t2, clamp(c, t2), 64)


def resolve(frame, overrides):
    maxval = overrides[0] or (1 << frame["bits"]) - 1
    effective = [given or default for given, default in zip(overrides[1:], defaults(maxval, frame["near"]))]
    return (maxval, *effective)


def fixture(bits, maxval, near, width, height, long_reset=False):
    if maxval < 3:
        return (maxval,)
    if long_reset:
        return tuple(maxval if y % 2 else 0 for y in range(height) for _ in range(width))
    rng = random.Random(0x870200 + bits * 71 + maxval * 29 + near)
    edges = [0, max(0, near - 1), near, near + 1, maxval - near - 1, maxval - near, maxval]
    rows = [
        [0] * width,
        [0 if x < 21 else maxval for x in range(width)],
        [x % 2 * maxval for x in range(width)],
        [x * maxval // (width - 1) for x in range(width)],
        [maxval if x < 16 else 0 for x in range(width)],
        [edges[x % len(edges)] for x in range(width)],
        *[[rng.randrange(maxval + 1) for _ in range(width)] for _ in range(height - 6)],
    ]
    return tuple(pixel for row in rows for pixel in row)


def small_vector(frame, maxval, sample, preset=None):
    # A single top-left sample sees zero neighbours. Run length zero is coded 0
    # on interruption. Initial RItype 1 has A=2,N=1 so Golomb k=1. For MAXVAL
    # 1 or 2, the range-reduced error is -1 at the upper sample and +1 only
    # at sample 1 with MAXVAL=2 and NEAR=0. Mapped errors are 0 and 1.
    near = frame["near"]
    if sample <= near:
        entropy, value = 0x80, 0
    else:
        entropy, value = (0x40 if sample == maxval else 0x60), sample
    start = bytes.fromhex("ffd8fff7000b")
    sof = struct.pack(">BHHBBBB", frame["bits"], 1, 1, 1, 1, 0x11, 0)
    scan = bytes.fromhex("ffda0008010100") + bytes((near, 0, 0, entropy)) + bytes.fromhex("ffd9")
    return start + sof + lse((maxval, *(preset or (0, 0, 0, 0)))) + scan, (value,)


class HpOracle:
    def __init__(self, archive_path, workdir):
        archive = archive_path.read_bytes()
        assert digest(archive) == ARCHIVE_SHA256, "unexpected ITU reference archive SHA-256"
        self.workdir = workdir
        self.binaries = {}
        with ZipFile(archive_path) as source:
            for name in ("locoe", "locod", "nlocoe", "nlocod", "loco16e", "loco16d", "nloco16e", "nloco16d"):
                filename = name + ".exe"
                binary = source.read(filename)
                (workdir / filename).write_bytes(binary)
                self.binaries[filename] = digest(binary)

    @staticmethod
    def name(maxval, near, operation):
        return ("n" if near else "") + "loco" + ("16" if maxval > 255 else "") + operation + ".exe"

    def encode(self, frame, pixels, maxval, preset):
        width, height, near = (frame[field] for field in ("width", "height", "near"))
        pgm = f"P5\n{width} {height}\n{maxval}\n".encode() + pack_samples(pixels, wide=maxval > 255, big=True)
        (self.workdir / "in.pgm").write_bytes(pgm)
        output = self.workdir / "encoded.jls"
        output.unlink(missing_ok=True)
        command = [self.workdir / self.name(maxval, near, "e")]
        if near:
            command.append(f"-e{near}")
        if preset:
            command.extend(f"-{flag}{value}" for flag, value in zip(("Ta", "Tb", "Tc", "r"), preset))
        run([*command, "in.pgm", "-oencoded.jls"], cwd=self.workdir, timeout=30)
        return output.read_bytes()

    def decode(self, stream, frame, maxval):
        (self.workdir / "in.jls").write_bytes(stream)
        output = self.workdir / "decoded.pgm"
        output.unlink(missing_ok=True)
        run([self.workdir / self.name(maxval, frame["near"], "d"), "in.jls", "decoded.pgm"],
            cwd=self.workdir, timeout=30)
        pgm = output.read_bytes()
        header = re.match(rb"P5\s+(\d+)\s+(\d+)\s+(\d+)(?:\r\n|\s)", pgm)
        assert header is not None
        assert tuple(map(int, header.groups())) == (frame["width"], frame["height"], maxval)
        pixels = unpack_samples(pgm[header.end():], wide=maxval > 255, big=True)
        assert len(pixels) == frame["width"] * frame["height"]
        return pixels


def configurations():
    for bits in range(2, 17):
        full = (1 << bits) - 1
        for maxval in sorted({1, 2, (1 << (bits - 2)) + 1, full // 2, 1 << (bits - 1), full * 3 // 4, full - 1, full}):
            upper = min(255, maxval // 2)
            for near in sorted({0, min(1, upper), max(0, upper - 1), upper}):
                yield f"p{bits}-m{maxval}-n{near}", bits, maxval, near, None, False, None
    custom = [
        (3, 5, 1, (2, 3, 4, 3)),
        (7, 97, 3, (10, 10, 10, 31)),
        (8, 255, 0, (9, 9, 9, 31)),
        (9, 256, 2, (4, 7, 40, 255)),
        (12, 1000, 3, (10, 20, 90, 333)),
        (16, 65534, 255, (256, 1024, 4096, 65534)),
        (16, 65535, 0, (16, 63, 500, 65535)),
    ]
    for bits, maxval, near, preset in custom:
        yield f"custom-p{bits}-m{maxval}-n{near}", bits, maxval, near, preset, False, None
    yield "reset-65535-long", 16, 65535, 0, (16, 63, 500, 65535), True, None
    for sample in (0, 1):
        for maxval, near in ((1, 0), (2, 0), (2, 1)):
            yield f"tiny-p2-m{maxval}-n{near}-s{sample}", 2, maxval, near, None, False, sample


def make_cases(directory, oracle):
    cases = []
    for stem, bits, maxval, near, preset, long_reset, single_sample in configurations():
        width, height = (1, 1) if maxval < 3 else (257, 600) if long_reset else (31, 9)
        frame = {"width": width, "height": height, "bits": bits, "near": near}
        input_frame = dict(frame)
        if maxval != (1 << bits) - 1:
            input_frame["maxval"] = maxval
        if preset:
            input_frame["preset"] = dict(zip(FIELDS[1:], preset))
        effective = (maxval, *(preset or defaults(maxval, near)))
        expected = dict(frame, maxval=maxval)
        if preset and preset != defaults(maxval, near):
            expected["preset"] = dict(zip(FIELDS[1:], effective[1:]))
        original = fixture(bits, maxval, near, width, height, long_reset) if single_sample is None else (single_sample,)
        try:
            if maxval < 3:
                stream, reconstructed = small_vector(frame, maxval, original[0], preset)
                reference = "T.87 Annex A 1x1 vector"
            else:
                # The historical encoder's low-MAXVAL default choices differ
                # for some NEAR values. Supply the standard-effective values.
                coded = oracle.encode(frame, original, maxval, effective[1:])
                canonical_frame, values = inspect_header(coded)
                assert canonical_frame == dict(frame, bits=maxval.bit_length())
                assert resolve(canonical_frame, values) == effective, (values, effective)
                reconstructed = oracle.decode(coded, canonical_frame, maxval)
                if canonical_frame["bits"] != bits:
                    stream = rewrite_header(coded, bits=bits, presets=[effective])
                    reference = "HP V.1.00, SOF precision adapted with explicit effective LSE"
                else:
                    stream = coded
                    reference = "HP V.1.00 direct"
            reference_maximum = check_pixels(reconstructed, original, near, f"{stem}/independent")
            physical, values = inspect_header(stream)
            assert physical == frame and resolve(physical, values) == effective
        except Exception as error:
            raise RuntimeError(f"{stem}: {error}") from error
        input_file = f"{stem}.input.raw"
        source_file = f"{stem}.reference.jls"
        reference_file = f"{stem}.reference.raw"
        paths = {input_file: pack_samples(original), source_file: stream, reference_file: pack_samples(reconstructed)}
        for filename, data in paths.items():
            (directory / filename).write_bytes(data)
        cases.append({"id": stem, "frame": input_frame, "expected": expected, "effectivePreset": dict(zip(FIELDS, effective)),
                      "source": reference, "input": input_file, "reference": source_file, "referenceSamples": reference_file,
                      "referenceMaxAbsoluteError": reference_maximum, "sha256": {name: digest(value) for name, value in paths.items()}})
    return cases


def make_variants(directory, cases):
    custom = next(case for case in cases if case["id"] == "custom-p7-m97-n3")
    default = next(case for case in cases if case["id"] == "p8-m255-n0")
    source = (directory / custom["reference"]).read_bytes()
    ordinary = (directory / default["reference"]).read_bytes()
    effective = tuple(custom["effectivePreset"][field] for field in FIELDS)
    near_position, entropy_position = next((pos + 7, end) for code, pos, end, _ in markers(source) if code == 0xDA)
    lse_position = next(pos for code, pos, _, _ in markers(source) if code == 0xF8)
    data = []

    def accept(name, stream, case):
        data.append((name, stream, {"expected": case["expected"], "effectivePreset": case["effectivePreset"],
                                    "referenceSamples": case["referenceSamples"]}))

    def reject(name, stream, code="InvalidData"):
        data.append((name, stream, {"expectedCode": code}))

    accept("lse-before-sof", rewrite_header(source, presets=[effective], before_frame=True), custom)
    accept("lse-last-definition-wins", rewrite_header(source, presets=[(97, 5, 8, 11, 5), effective]), custom)
    accept("lse-zero-resets-prior-definition", rewrite_header(ordinary, presets=[effective, (0, 0, 0, 0, 0)]), default)
    accept("lse-explicit-defaults", rewrite_header(ordinary, presets=[(255, 3, 7, 21, 64)]), default)
    accept("lse-mixed-zero-fields", rewrite_header(ordinary, presets=[(255, 0, 7, 0, 64)]), default)
    reject("lse-maxval-over-precision", rewrite_header(source, presets=[(128, *effective[1:])]))
    reject("lse-near-over-maxval", source[:near_position] + bytes((49,)) + source[near_position + 1:])
    for name, params in (
        ("t1-under-near", (97, 3, 10, 10, 31)),
        ("t2-under-t1", (97, 10, 9, 10, 31)),
        ("t3-under-t2", (97, 10, 10, 9, 31)),
        ("t3-over-maxval", (97, 10, 10, 98, 31)),
        ("reset-under-3", (97, 10, 10, 10, 2)),
        ("reset-over-limit", (97, 10, 10, 10, 256)),
    ):
        reject(f"lse-{name}", rewrite_header(source, presets=[params]))
    reject("lse-truncated-payload", source[:lse_position + 11], "Truncated")
    reject("lse-invalid-length", source[:lse_position + 3] + bytes((12,)) + source[lse_position + 4:])
    reject("lse-inside-entropy", source[:entropy_position] + lse(effective) + source[entropy_position:])
    reject("lse-after-scan", source[:-2] + lse(effective) + source[-2:], "UnsupportedFeature")
    reject("lse-after-eoi", source + lse(effective), "TrailingData")

    variants = []
    for name, stream, expectation in data:
        filename = f"{name}.jls"
        (directory / filename).write_bytes(stream)
        variants.append({"id": name, "input": filename, "sha256": digest(stream), **expectation})
    return variants


def bad_encodes():
    frame = {"width": 1, "height": 1, "bits": 7, "near": 3, "maxval": 97}
    cases = [
        ("p-below-min", dict(frame, bits=1), 1),
        ("p-above-max", dict(frame, bits=17), 1),
        ("maxval-over-precision", dict(frame, maxval=128), 1),
        ("near-over-maxval", dict(frame, near=49), 1),
        ("sample-over-maxval", frame, 98),
        ("threshold-order", dict(frame, preset={"t1": 10, "t2": 9, "t3": 10, "reset": 31}), 1),
        ("reset-over-limit", dict(frame, preset={"t1": 10, "t2": 10, "t3": 10, "reset": 256}), 1),
    ]
    return [{"id": f"encode-{name}", "frame": value, "sample": sample, "expectedCode": "InvalidArgument"}
            for name, value, sample in cases]


def cli_flags(frame):
    args = []
    if "maxval" in frame:
        args.extend(("--maxval", frame["maxval"]))
    for field, value in frame.get("preset", {}).items():
        args.extend((f"--{field}", value))
    return args


def cli_encode(binary, frame, original, chunk, *, check=True):
    dimensions = [frame[field] for field in ("width", "height", "bits", "near")]
    return run([binary, "encode", *dimensions, "-", "-", "raw-le", chunk, *cli_flags(frame)],
               input_data=pack_samples(original, wide=frame["bits"] > 8), check=check)


def cli_decode(binary, stream, bits, chunk):
    output = run([binary, "decode", "-", "-", "raw-le", chunk], input_data=stream).stdout
    return unpack_samples(output, wide=bits > 8)


def verify_native_header(binary, stream, frame, effective):
    verified = run([binary, "verify", "-", DEFAULT_CHUNK, "--json"], input_data=stream).stdout
    metadata = json.loads(verified)
    assert all(metadata[field] == frame[field] for field in ("width", "height", "bits", "near", "maxval"))
    assert metadata["rows"] == frame["height"]
    assert metadata["inputBytes"] == len(stream)
    assert metadata["preset"] == effective


def native_stage(directory, binary):
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    results = []
    # Linux filesystem executable startup is faster. Bit equality verifies the
    # executable copied into the temporary directory is the requested artifact.
    with tempfile.TemporaryDirectory(prefix="moonjls-m2-native-") as tmp:
        staged = Path(tmp) / "moonjls"
        shutil.copy2(binary, staged)
        binary_hash = digest(binary.read_bytes())
        assert digest(staged.read_bytes()) == binary_hash
        for case in manifest["cases"]:
            stem, frame = case["id"], case["frame"]
            original = unpack_samples((directory / case["input"]).read_bytes())
            external = (directory / case["reference"]).read_bytes()
            reference = unpack_samples((directory / case["referenceSamples"]).read_bytes())
            try:
                normal = cli_encode(staged, frame, original, DEFAULT_CHUNK).stdout
                split = cli_encode(staged, frame, original, 1).stdout
                assert normal == split, "native stream differs by encode quantum"
                rebuilt = cli_decode(staged, normal, frame["bits"], 1)
                assert cli_decode(staged, external, frame["bits"], 1) == reference
                assert cli_decode(staged, external, frame["bits"], DEFAULT_CHUNK) == reference
                verify_native_header(staged, external, case["expected"], case["effectivePreset"])
                maximum = check_pixels(rebuilt, original, frame["near"], f"{stem}/native")
            except Exception as error:
                raise RuntimeError(f"{stem}/native: {error}") from error
            reconst = pack_samples(rebuilt)
            (directory / f"{stem}.native.jls").write_bytes(normal)
            (directory / f"{stem}.native.raw").write_bytes(reconst)
            results.append({"id": stem, "backend": "native", "bytes": len(normal), "streamSha256": digest(normal),
                            "reconstructionSha256": digest(reconst), "maxAbsoluteError": maximum})

        for case in manifest["variants"]:
            stem = case["id"]
            stream = (directory / case["input"]).read_bytes()
            operation = [staged, "verify", "-", 1, "--json"]
            result = run(operation, input_data=stream, check=False)
            if code := case.get("expectedCode"):
                token = b"CommandError.Input" if code == "TrailingData" else code.encode()
                assert result.returncode and token in result.stderr and not result.stdout, (stem, result.stderr)
                results.append({"id": stem, "backend": "native", "code": code,
                                "stderr": result.stderr.decode().strip()})
            else:
                assert result.returncode == 0, (stem, result.stderr)
                verify_native_header(staged, stream, case["expected"], case["effectivePreset"])
                pixels = cli_decode(staged, stream, case["expected"]["bits"], 1)
                expected = (directory / case["referenceSamples"]).read_bytes()
                assert pack_samples(pixels) == expected, stem
                results.append({"id": stem, "backend": "native", "reconstructionSha256": digest(expected)})

        for case in manifest["invalidEncodes"]:
            result = cli_encode(staged, case["frame"], (case["sample"],), 1, check=False)
            assert result.returncode and case["expectedCode"].encode() in result.stderr, (case["id"], result.stderr)
            results.append({"id": case["id"], "backend": "native", "code": case["expectedCode"],
                            "stderr": result.stderr.decode().strip()})

        pgm_results = []
        candidates = ["p2-m1-n0", "p9-m255-n1", "p9-m256-n1", "p16-m2-n1",
                      "custom-p9-m256-n2", "custom-p16-m65534-n255"]
        for stem in candidates:
            case = next(case for case in manifest["cases"] if case["id"] == stem)
            frame, expected = case["frame"], case["expected"]
            width, height, maxval = (expected[field] for field in ("width", "height", "maxval"))
            wide = maxval > 255
            raw = unpack_samples((directory / f"{stem}.native.raw").read_bytes())
            stream = (directory / f"{stem}.native.jls").read_bytes()
            header = f"P5\n{width} {height}\n{maxval}\n".encode()
            output = run([staged, "decode", "-", "-", "pgm", 1], input_data=stream).stdout
            assert output == header + pack_samples(raw, wide=wide, big=True), stem
            original = unpack_samples((directory / case["input"]).read_bytes())
            pgm = header + pack_samples(original, wide=wide, big=True)
            flags = cli_flags({field: value for field, value in frame.items() if field != "maxval"})
            encoded = run([staged, "encode-pgm", frame["near"], "-", "-", 1, *flags], input_data=pgm).stdout
            stored, preset_fields = inspect_header(encoded)
            assert stored["bits"] == max(2, maxval.bit_length())
            assert dict(zip(FIELDS, resolve(stored, preset_fields))) == case["effectivePreset"]
            assert cli_decode(staged, encoded, stored["bits"], 1) == raw
            pgm_results.append({"id": stem, "pgmSha256": digest(output), "pgmEncodedSha256": digest(encoded),
                                "storageBytesPerSample": 2 if wide else 1, "encodedBits": stored["bits"]})

    result = {"binarySha256": binary_hash, "platform": sys.platform, "results": results, "pgm": pgm_results}
    dump(directory / "native-results.json", result)
    print(json.dumps({"native": len(results), "pgm": len(pgm_results)}), flush=True)


def reciprocal(directory, cases, oracle):
    checks = []
    for case in cases:
        stem, frame = case["id"], case["expected"]
        actual = (directory / f"{stem}.native.jls").read_bytes()
        pixels = (directory / f"{stem}.native.raw").read_bytes()
        for backend in BACKENDS[:-1]:
            assert (directory / f"{stem}.{backend}.jls").read_bytes() == actual, f"{stem}: {backend} stream"
            assert (directory / f"{stem}.{backend}.raw").read_bytes() == pixels, f"{stem}: {backend} samples"
        physical, header_presets = inspect_header(actual)
        assert physical == {field: frame[field] for field in ("width", "height", "bits", "near")}
        assert dict(zip(FIELDS, resolve(physical, header_presets))) == case["effectivePreset"]
        maxval = frame["maxval"]
        if maxval >= 3:
            hp_bits = maxval.bit_length()
            preset = None if all(header_presets) else [tuple(case["effectivePreset"][field] for field in FIELDS)]
            stream = actual if physical["bits"] == hp_bits and preset is None else rewrite_header(actual, bits=hp_bits, presets=preset)
            source = "HP V.1.00 direct" if stream == actual else "HP V.1.00, SOF or LSE normalized for reference"
            independently = oracle.decode(stream, dict(physical, bits=hp_bits), maxval)
        else:
            samples = unpack_samples((directory / case["input"]).read_bytes())
            reference, independently = small_vector(physical, maxval, samples[0])
            entropy_at = next(end for code, _, end, _ in markers(actual) if code == 0xDA)
            reference_at = next(end for code, _, end, _ in markers(reference) if code == 0xDA)
            assert actual[entropy_at:] == reference[reference_at:], f"{stem}: T.87 analytic entropy"
            source = case["source"]
        assert pack_samples(independently) == pixels, f"{stem}: independent reconstruction differs"
        checks.append({"id": stem, "source": source, "streamSha256": digest(actual), "reconstructionSha256": digest(pixels)})
    return checks


def windows_path_in_wsl(path, distro):
    return run(["wsl", "-d", distro, "--exec", "wslpath", "-a", "-u", path]).stdout.decode().strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / ".evidence" / "m2-matrix")
    parser.add_argument("--hp-archive", type=Path, help="Official ITU jlsrefV100.zip")
    parser.add_argument("--native-binary", type=Path)
    parser.add_argument("--native-wsl", help="WSL distribution running the true CLI release")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--native-stage", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.native_stage:
        native_stage(directory, args.native_binary.resolve(strict=True))
        return
    if not args.hp_archive or (not args.prepare_only and not args.native_binary):
        parser.error("--hp-archive and --native-binary are required for the full run")
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="moonjls-hp-reference-") as tmp:
        oracle = HpOracle(args.hp_archive, Path(tmp))
        cases = make_cases(directory, oracle)
        variants = make_variants(directory, cases)
        invalid = bad_encodes()
        manifest = {"referenceArchiveSha256": ARCHIVE_SHA256, "referenceBinariesSha256": oracle.binaries,
                    "cases": cases, "variants": variants, "invalidEncodes": invalid}
        dump(directory / "manifest.json", manifest)
        print(f"Prepared {len(cases)} positive cases, {len(variants)} wire variants, and {len(invalid)} invalid encodes.", flush=True)
        if args.prepare_only:
            return
        sdk = run(["node", ROOT / "scripts/test_m2.mjs", directory], timeout=240)
        print(sdk.stdout.decode().strip(), flush=True)
        binary = args.native_binary.resolve(strict=True)
        if args.native_wsl:
            distro = args.native_wsl
            paths = [windows_path_in_wsl(path, distro) for path in (Path(__file__).resolve(), directory, binary)]
            native = run(["wsl", "-d", distro, "--exec", "python3", paths[0], "--native-stage",
                          "--directory", paths[1], "--native-binary", paths[2]], timeout=480)
            print(native.stdout.decode().strip(), flush=True)
        else:
            native_stage(directory, binary)
        comparisons = reciprocal(directory, cases, oracle)
        details = {"artifactSha256": {"native": digest(binary.read_bytes()),
                                     "js": digest((ROOT / "sdk/generated/core.mjs").read_bytes()),
                                     "wasm-gc": digest((ROOT / "sdk/generated/core.wasm").read_bytes())},
                   "results": json.loads((directory / "sdk-results.json").read_text(encoding="utf-8")),
                   "native": json.loads((directory / "native-results.json").read_text(encoding="utf-8")),
                   "reciprocal": comparisons, "pass": True}
        dump(directory / "report.json", details)
        print(f"Passed {len(comparisons)} bidirectional cross-backend cases.", flush=True)


if __name__ == "__main__":
    main()
