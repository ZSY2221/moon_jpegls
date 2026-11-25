#!/usr/bin/env python3
"""Linux/WSL Native CLI regression for multi-scan row delivery, scan boundaries and strict EOI."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import selectors
from subprocess import PIPE, Popen, run
from time import monotonic


def digest_bytes(data):
    return sha256(data).hexdigest()


def observe(process, seconds):
    """Drain stdout and stderr without closing or supplying stdin."""
    output = bytearray()
    errors = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, output)
        selector.register(process.stderr, selectors.EVENT_READ, errors)
        deadline = monotonic() + seconds
        while selector.get_map():
            remaining = deadline - monotonic()
            if remaining <= 0:
                break
            for key, _ in selector.select(remaining):
                data = os.read(key.fd, 65536)
                if data:
                    key.data.extend(data)
                else:
                    selector.unregister(key.fileobj)
    return bytes(output), bytes(errors)


def cleanup(process):
    if process.poll() is None:
        process.kill()
    process.wait()


def build_planar_image(width, height, bits, components):
    plane_pixels = width * height
    storage = 1 if bits <= 8 else 2
    maxval = (1 << bits) - 1
    raw = bytearray(plane_pixels * components * storage)
    seed = 0x13579BDF
    offset = 0
    for comp in range(components):
        for y in range(height):
            for x in range(width):
                seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
                base = ((comp * 73 + x * 17 + y * 31) % 251) / 250.0
                val = int((base * 0.7 + ((seed >> 24) / 255.0) * 0.3) * maxval) & maxval
                if storage == 1:
                    raw[offset] = val
                    offset += 1
                else:
                    raw[offset] = val & 0xFF
                    raw[offset + 1] = (val >> 8) & 0xFF
                    offset += 2
    return bytes(raw)


def send_chunks(fd, data, max_chunk=4096):
    pos = 0
    sizes = []
    while pos < len(data):
        part = data[pos:pos + max_chunk]
        written = os.write(fd, part)
        if written <= 0:
            raise AssertionError("failed writing chunk to decoder stdin")
        sizes.append(written)
        pos += written
    return sizes


def multiscan_delivery_trial(binary, width, height, bits, components, obs_seconds, timeout):
    raw = build_planar_image(width, height, bits, components)
    row_bytes = width * (1 if bits <= 8 else 2)
    plane_bytes = height * row_bytes
    assert len(raw) == components * plane_bytes

    enc = run(
        [str(binary), "encode-planar", str(width), str(height), str(bits),
         str(components), "0", "-", "-", "raw-le", "4096"],
        input=raw,
        capture_output=True,
        timeout=timeout,
        check=True,
    )
    stream = enc.stdout
    assert stream.startswith(b"\xff\xd8") and stream.endswith(b"\xff\xd9")

    insp = run(
        [str(binary), "inspect", "-", "4096", "--json"],
        input=stream,
        capture_output=True,
        timeout=timeout,
        check=True,
    )
    meta = json.loads(insp.stdout.decode("utf-8"))
    scans = meta["scans"]
    assert len(scans) == components
    scan0_end = scans[0]["endOffset"]
    scan1_end = scans[1]["endOffset"]
    assert 0 < scan0_end < scan1_end < len(stream)

    command = [str(binary), "decode", "-", "-", "raw-le", "4096"]
    with Popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE, bufsize=0) as process:
        try:
            # Stage 1: feed <=4096 B chunks ending precisely at Scan 1 end while withholding Scan 2+3+EOI.
            c1 = send_chunks(process.stdin.fileno(), stream[:scan0_end], 4096)
            out1, err1 = observe(process, obs_seconds)
            alive_after_scan1 = process.poll() is None

            # Stage 2: feed Scan 2 while withholding Scan 3 + EOI.
            c2 = send_chunks(process.stdin.fileno(), stream[scan0_end:scan1_end], 4096)
            out2, err2 = observe(process, obs_seconds)
            alive_after_scan2 = process.poll() is None

            # Stage 3: feed Scan 3 + EOI, keep stdin open to check strict EOF wait, then close stdin.
            c3 = send_chunks(process.stdin.fileno(), stream[scan1_end:], 4096)
            out3, err3 = observe(process, obs_seconds)
            waited_for_eof = process.poll() is None
            process.stdin.close()
            process.stdin = None
            out4, err4 = process.communicate(timeout=timeout)
            code = process.returncode
        finally:
            cleanup(process)

    full_out = out1 + out2 + out3 + out4
    stderr = (err1 + err2 + err3 + err4).decode(errors="replace")
    passed = (
        code == 0
        and alive_after_scan1
        and alive_after_scan2
        and waited_for_eof
        and len(out1) == plane_bytes
        and out1 == raw[:plane_bytes]
        and len(out2) == plane_bytes
        and out2 == raw[plane_bytes:2 * plane_bytes]
        and len(out3) == (components - 2) * plane_bytes
        and not out4
        and full_out == raw
    )
    return {
        "case": f"multiscan-delivery-{bits}b-{components}ch",
        "width": width,
        "height": height,
        "bits": bits,
        "components": components,
        "streamBytes": len(stream),
        "streamSha256": digest_bytes(stream),
        "scan0EndOffset": scan0_end,
        "scan1EndOffset": scan1_end,
        "eoiOffset": meta["eoiOffset"],
        "chunkWrites": {"scan1": c1, "scan2": c2, "scan3PlusEoi": c3},
        "planeBytes": plane_bytes,
        "deliveredBeforeScan2Bytes": len(out1),
        "deliveredAfterScan2BeforeScan3Bytes": len(out2),
        "deliveredAtEoiBeforeEofBytes": len(out3),
        "deliveredAfterEofBytes": len(out4),
        "aliveAfterScan1": alive_after_scan1,
        "aliveAfterScan2": alive_after_scan2,
        "waitedForStdinEof": waited_for_eof,
        "outputExact": full_out == raw,
        "exitCode": code,
        "stderr": stderr,
        "passed": passed,
    }, stream, raw


def late_tail_multiscan_trial(binary, stream, raw, obs_seconds, timeout):
    command = [str(binary), "decode", "-", "-", "raw-le", "4096"]
    with Popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE, bufsize=0) as process:
        try:
            send_chunks(process.stdin.fileno(), stream, 4096)
            before, err1 = observe(process, obs_seconds)
            waited_for_eof = process.poll() is None
            os.write(process.stdin.fileno(), b"\x00")
            process.stdin.close()
            process.stdin = None
            after, err2 = process.communicate(timeout=timeout)
            code = process.returncode
        finally:
            cleanup(process)
    stderr = (err1 + err2).decode(errors="replace")
    return {
        "case": "multiscan-late-tail-rejected",
        "deliveredBeforeTailBytes": len(before),
        "deliveredAfterTailBytes": len(after),
        "waitedForStdinEof": waited_for_eof,
        "exitCode": code,
        "stderr": stderr,
        "passed": (
            before == raw
            and not after
            and waited_for_eof
            and code != 0
            and "CommandError.Input" in stderr
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--observation-seconds", type=float, default=0.8)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)

    t16, stream16, raw16 = multiscan_delivery_trial(
        binary, 96, 48, 16, 3, args.observation_seconds, args.timeout
    )
    t8, _, _ = multiscan_delivery_trial(
        binary, 64, 16, 8, 4, args.observation_seconds, args.timeout
    )
    tail = late_tail_multiscan_trial(
        binary, stream16, raw16, args.observation_seconds, args.timeout
    )
    trials = [t16, t8, tail]
    report = {
        "binary": str(binary),
        "binarySha256": sha256(binary.read_bytes()).hexdigest(),
        "trials": trials,
        "passed": all(t["passed"] for t in trials),
    }
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
