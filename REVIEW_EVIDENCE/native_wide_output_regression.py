"""Verify exact raw32 output and streaming boundaries on Linux or WSL."""

import argparse
import json
import re
from pathlib import Path
from struct import pack
from tempfile import TemporaryDirectory

from native_sampling_delivery_regression import call, pgm, verify_delivery


# Independently derived by decoding the Pt=0 entropy with CharLS, then multiplying
# each reconstructed sample by 2 per T.87 §4.3.2. The eighth sample exceeds Uint16.
OVERFLOW = bytes.fromhex(
    "ffd8fff7000b100002000801011100ffda0008010100030001"
    "f40000a380001498008191e009219008ffd9"
)
OVERFLOW_SAMPLES = (
    0, 0, 0, 0, 0, 32760, 65534, 65536, 0, 65520, 2, 2, 2, 2, 65534, 65534,
)

# Annex A run interruption starts with k=10 at MAXVAL=65535. The untransformed
# values 65535 and 7 have reduced errors -1 and 7, hence EMErrval 0 and 13.
# One zero run bit, the Rice code, and zero fill give 4000 and 40d0.
# The first scan stress-tests the decoder's inversion bound at Pt=15.
MIXED = bytes.fromhex(
    "ffd8fff7000e100001000102011100021100"
    "ffda000801010000000f4000"
    "ffda000801020000000040d0"
    "ffd9"
)
MIXED_SAMPLES = (0x7FFF8000, 7)


def raw32(samples, order):
    return pack(f"{order}{len(samples)}I", *samples)


def verify_chunk_matrix(binary, stream, samples, rows):
    runs = []
    for fmt, order in (("raw32-le", "<"), ("raw32-be", ">")):
        expected = raw32(samples, order)
        for chunk in (1, 2, 3, 4, 7, 4096):
            result = call([binary, "decode", "-", "-", fmt, str(chunk)], stream)
            assert result.stdout == expected, (fmt, chunk, result.stdout.hex())
            stats = {key.decode(): int(value) for key, value in re.findall(rb"(\w+)=([0-9]+)", result.stderr)}
            assert stats["output_sample_bytes"] == 4
            assert stats["rows"] == rows
            assert stats["output_bytes"] == len(expected)
            assert stats["input_high_water"] <= chunk
            assert 4 <= stats["output_high_water"] <= max(chunk, 4)
            assert stats["first_row_at"] <= len(stream) - 2
            assert stats["host_conversion_buffer_bytes"] == 0
            runs.append({"format": fmt, "chunk": chunk, "outputPeakBytes": stats["output_high_water"]})
    return runs


def sampled_fixture(binary):
    # Two MCUs with sample-dependent rows, unequal component dimensions and
    # five padding rows. Expected output is independently ordered by MCU.
    widths, heights, v_factors = (5, 3, 5), (5, 4, 2), (4, 3, 1)
    planes = [
        bytes((slot * 71 + sample * 19) % 256 for sample in range(width * height))
        for slot, (width, height) in enumerate(zip(widths, heights))
    ]
    samples = []
    for mcu in range(2):
        for plane, width, height, v in zip(planes, widths, heights, v_factors):
            begin, end = mcu * v, min((mcu + 1) * v, height)
            samples.extend(value & 0xFC for value in plane[begin * width:end * width])
    assert len(samples) == 47
    with TemporaryDirectory(prefix="moonjls-native-wide-") as temporary:
        files = [Path(temporary) / f"plane-{i}.pgm" for i in range(len(planes))]
        for file, plane, width, height in zip(files, planes, widths, heights):
            file.write_bytes(pgm(plane, width, height))
        result = call([binary, "encode-pgms", "0", "-", "--ilv", "1", "--pt", "2",
                       "--sampling", "2x4,1x3,2x1", "--chunk", "7", *map(str, files)])
        return result.stdout, samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native_cli", type=Path)
    args = parser.parse_args()
    binary = str(args.native_cli.resolve(strict=True))

    overflow = verify_chunk_matrix(binary, OVERFLOW, OVERFLOW_SAMPLES, 2)
    mixed = verify_chunk_matrix(binary, MIXED, MIXED_SAMPLES, 2)
    for fmt in ("raw-le", "raw-be", "pgm"):
        result = call([binary, "decode", "-", "-", fmt, "1"], OVERFLOW, check=False)
        assert result.returncode != 0
        assert b"UnsupportedFeature" in result.stderr
        assert b"output sample range" in result.stderr

    attempted_wide_encode = call([binary, "encode", "1", "1", "16", "0", "-", "-", "raw32-le", "1"],
                                 b"\x00" * 4, check=False)
    assert attempted_wide_encode.returncode != 0

    stream, samples = sampled_fixture(binary)
    sampled = verify_chunk_matrix(binary, stream, samples, 11)
    delivery = verify_delivery([binary, "decode", "-", "-", "raw32-le", "1"], stream, raw32(samples, "<"))
    assert delivery["payloadBytesBeforeEoi"] == 47 * 4
    print(json.dumps({
        "status": "passed",
        "knownOverflow": {"samples": len(OVERFLOW_SAMPLES), "value": 65536, "runs": overflow},
        "mixedScans": {"samples": list(MIXED_SAMPLES), "runs": mixed},
        "sampled": {"samples": len(samples), "rows": 11, "runs": sampled, **delivery},
    }, indent=2))


if __name__ == "__main__":
    main()
