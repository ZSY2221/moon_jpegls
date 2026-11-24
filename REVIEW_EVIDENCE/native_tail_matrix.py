"""Check Native CLI chunk sizes, provisional rows and strict EOI handling on Linux/WSL."""

import argparse
import json
from pathlib import Path
from subprocess import PIPE, Popen, run

from audit_native_pipe import read_available


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native_cli", type=Path)
    args = parser.parse_args()
    binary = args.native_cli.resolve(strict=True)
    pixels = bytes(4)
    stream = bytes.fromhex("ffd8fff7000b080004000101011100ffda0008010100000000f0ffd9")
    cases = {
        "complete": (stream, None),
        "missing-eoi": (stream[:-2], b"Truncated"),
        "short-eoi": (stream[:-1], b"Truncated"),
        "nonzero-padding": (stream[:-3] + b"\xf1" + stream[-2:], b"InvalidData"),
        "trailing-data": (stream + b"\0", b"trailing bytes after EOI"),
    }
    trials = []
    for chunk in (1, 2, 7, 4096):
        command = [binary, "decode", "-", "-", "raw-le", str(chunk)]
        for name, (data, expected_error) in cases.items():
            result = run(command, input=data, capture_output=True, timeout=5)
            assert result.stdout == pixels, (name, chunk, result.stdout)
            if expected_error is None:
                assert result.returncode == 0, result.stderr
                assert b"input_bytes=28" in result.stderr, result.stderr
            else:
                assert result.returncode != 0 and expected_error in result.stderr, (name, chunk, result.stderr)
            trials.append({"case": name, "chunk": chunk, "exitCode": result.returncode})
    with Popen([binary, "decode", "-", "-", "raw-le", "7"], stdin=PIPE, stdout=PIPE, stderr=PIPE) as process:
        try:
            process.stdin.write(stream)
            process.stdin.flush()
            assert read_available(process.stdout, 1.0) == pixels
            assert process.poll() is None, "Strict completion must wait for source EOF"
            process.stdin.write(b"\0")
            process.stdin.close()
            process.stdin = None
            extra, error = process.communicate(timeout=5)
            assert not extra and process.returncode != 0 and b"trailing bytes after EOI" in error, error
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    print(json.dumps({"trials": trials, "lateTrailingDataWhileInputOpen": "rejected"}, indent=2))


if __name__ == "__main__":
    main()
