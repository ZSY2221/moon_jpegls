"""Observe when an already decodable row reaches Native CLI stdout on Linux/WSL."""

import argparse
import hashlib
import json
import os
from pathlib import Path
from select import select
from subprocess import PIPE, Popen, run
from time import monotonic


def read_available(stream, duration):
    deadline = monotonic() + duration
    chunks = []
    while (remaining := deadline - monotonic()) > 0:
        readable, _, _ = select([stream], [], [], remaining)
        if not readable:
            break
        part = os.read(stream.fileno(), 4096)
        if not part:
            break
        chunks.append(part)
    return b"".join(chunks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native_cli", type=Path)
    parser.add_argument("--require-eager", action="store_true")
    args = parser.parse_args()
    binary = args.native_cli.resolve(strict=True)
    samples = bytes(4)
    encoded = run(
        [binary, "encode", "1", "4", "8", "0", "-", "-", "raw-le", "1"],
        input=samples, capture_output=True, check=True, timeout=5,
    ).stdout
    # Four zero-valued rows encode as four run bits in the same entropy byte.
    assert encoded[-3:] == bytes.fromhex("f0 ff d9"), encoded.hex()
    observation_seconds = 1.0
    with Popen([binary, "decode", "-", "-", "raw-le", "1"], stdin=PIPE, stdout=PIPE, stderr=PIPE) as process:
        try:
            process.stdin.write(encoded[:-2])
            process.stdin.flush()
            before_eoi = read_available(process.stdout, observation_seconds)
            process.stdin.write(encoded[-2:])
            process.stdin.close()
            process.stdin = None
            after_eoi, diagnostics = process.communicate(timeout=5)
            assert process.returncode == 0, diagnostics.decode(errors="replace")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    assert before_eoi + after_eoi == samples
    print(json.dumps({
        "nativeBinarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "width": 1, "height": 4, "bits": 8, "near": 0, "nativeChunkBytes": 1,
        "encodedBytesHex": encoded.hex(), "withheldEoiBytes": 2,
        "observationSecondsBeforeEoi": observation_seconds,
        "rowsBeforeEoi": len(before_eoi), "rowsAfterEoi": len(after_eoi),
        "finalSamplesMatch": True,
    }, indent=2))
    if args.require_eager and before_eoi != samples:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
