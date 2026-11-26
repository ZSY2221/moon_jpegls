"""Check sampled Native row delivery and output geometry on Linux or WSL."""

import argparse
import json
from pathlib import Path
from subprocess import PIPE, Popen, run
from tempfile import TemporaryDirectory

from native_multiscan_delivery_regression import cleanup, digest_bytes, observe, send_chunks


def call(command, data=None, *, check=True):
    return run(command, input=data, capture_output=True, timeout=10, check=check)


def pgm(plane, width, height):
    return f"P5\n{width} {height}\n255\n".encode() + plane


def verify_delivery(command, stream, expected):
    with Popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE, bufsize=0) as process:
        try:
            writes = send_chunks(process.stdin.fileno(), stream[:-2], 1)
            before_eoi, first_stderr = observe(process, 0.7)
            assert before_eoi == expected, (len(before_eoi), len(expected), first_stderr)
            assert process.poll() is None, "Decoder exited while EOI was withheld"

            send_chunks(process.stdin.fileno(), stream[-2:], 1)
            after_eoi, second_stderr = observe(process, 0.7)
            assert not after_eoi, "A padded or duplicate row was delivered"
            assert process.poll() is None, "Strict decode exited before EOF"

            send_chunks(process.stdin.fileno(), b"\x00", 1)
            process.stdin.close()
            process.stdin = None
            after_tail, final_stderr = process.communicate(timeout=10)
            assert not after_tail
            assert process.returncode and b"CommandError.Input" in final_stderr
            return {
                "payloadBytesBeforeEoi": len(before_eoi),
                "largestInputWriteBeforeEoi": max(writes),
                "lateTailExitCode": process.returncode,
                "stderr": (first_stderr + second_stderr + final_stderr).decode(errors="replace"),
            }
        finally:
            cleanup(process)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native_cli", type=Path)
    args = parser.parse_args()
    binary = str(args.native_cli.resolve(strict=True))

    # 5x5, Hmax=2, Vmax=4, two MCUs, five padding lines, eleven valid lines.
    widths = (5, 3, 5)
    heights = (5, 4, 2)
    v_factors = (4, 3, 1)
    planes = [
        bytes((slot * 71 + sample * 19) % 256 for sample in range(width * height))
        for slot, (width, height) in enumerate(zip(widths, heights))
    ]
    pgms = [pgm(plane, width, height) for plane, width, height in zip(planes, widths, heights)]
    expected = bytearray()
    for mcu in range(2):
        for plane, width, height, v in zip(planes, widths, heights, v_factors):
            start = mcu * v * width
            end = min((mcu + 1) * v, height) * width
            expected.extend(plane[start:end])
    assert len(expected) == 47

    with TemporaryDirectory(prefix="moonjls-native-sampling-") as tmp:
        folder = Path(tmp)
        inputs = [folder / f"input-{i}.pgm" for i in range(3)]
        outputs = [folder / f"output-{i}.pgm" for i in range(3)]
        for file, data in zip(inputs, pgms):
            file.write_bytes(data)
        encoded = call([binary, "encode-pgms", "0", "-", "--ilv", "1",
                        "--sampling", "2x4,1x3,2x1", "--chunk", "7", *map(str, inputs)])
        stream = encoded.stdout
        assert stream.endswith(b"\xff\xd9")
        decoded = call([binary, "decode-pgms", "-", *map(str, outputs), "--chunk", "1"], stream)
        for path, data in zip(outputs, pgms):
            assert path.read_bytes() == data, path

    inspection = call([binary, "inspect", "-", "7", "--json"], stream)
    scan = json.loads(inspection.stdout)["scans"][0]
    assert scan["rows"] == sum(heights) and scan["completed"]
    full = call([binary, "decode", "-", "-", "raw-le", "7"], stream)
    assert full.stdout == expected
    ppm = call([binary, "decode", "-", "-", "ppm", "7"], stream, check=False)
    assert ppm.returncode != 0 and not ppm.stdout, "Unequal planes must never be exported as RGB PPM"
    delivery_command = [binary, "decode", "-", "-", "raw-le", "7"]
    details = verify_delivery(delivery_command, stream, expected)
    print(json.dumps({
        "status": "passed", "sampleCounts": [len(plane) for plane in planes], "validRows": scan["rows"],
        "streamSha256": digest_bytes(stream), "binarySha256": digest_bytes(Path(binary).read_bytes()),
        "encodeExitCode": encoded.returncode, "decodePgmsExitCode": decoded.returncode,
        "invalidPpmExitCode": ppm.returncode, "deliveryCommand": delivery_command, **details,
    }, indent=2))


if __name__ == "__main__":
    main()
