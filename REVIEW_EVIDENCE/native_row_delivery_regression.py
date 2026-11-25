#!/usr/bin/env python3
"""Linux/WSL Native CLI regression for row delivery, EOF and output backpressure.

This runs a supplied MoonBit-built CLI; it does not emulate the codec. Small
1x4 zero-image streams are fixed fixtures. Only the larger zero-image fixtures
are prepared with the supplied encoder, then checked against their known raw
pixels. No performance result is claimed by this diagnostic.
"""

import argparse
from array import array
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import selectors
from subprocess import PIPE, Popen, run
from termios import FIONREAD
from time import monotonic, sleep


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def queued(fd):
    value = array("i", [0])
    fcntl.ioctl(fd, FIONREAD, value, True)
    return value[0]


def observe(process, seconds):
    """Drain both pipes during a gate, without closing or supplying stdin."""
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


def send_prefix(process, data, fragmented, timeout):
    if not fragmented:
        process.stdin.write(data)
        process.stdin.flush()
        return [len(data)]
    deadline = monotonic() + timeout
    sizes = (1, 3, 5)
    sent = []
    position = 0
    while position < len(data):
        part = data[position:position + sizes[len(sent) % len(sizes)]]
        if os.write(process.stdin.fileno(), part) != len(part):
            raise AssertionError("short write of a small atomic input fragment")
        sent.append(len(part))
        position += len(part)
        # No two fragments can coalesce in the next source read. The small
        # fixture's output fits in its pipe while these header bytes are sent.
        while queued(process.stdin.fileno()):
            if process.poll() is not None or monotonic() >= deadline:
                raise TimeoutError("decoder did not consume the input fragment")
            sleep(0.002)
    return sent


def fixed_zero_stream(bits):
    # SOF55: one component, 1x4; SOS: NEAR=0/ILV=0; four run bits; EOI.
    stream = bytearray.fromhex("ffd8fff7000b080004000101011100ffda0008010100000000f0ffd9")
    stream[6] = bits
    return bytes(stream), bytes(4 * (1 if bits == 8 else 2))


def make_zero_stream(encoder, width, height, bits, timeout):
    raw = bytes(width * height * (1 if bits == 8 else 2))
    result = run([str(encoder), "encode", str(width), str(height), str(bits), "0",
                  "-", "-", "raw-le", "4096"], input=raw, capture_output=True,
                 timeout=timeout, check=True)
    if not result.stdout.startswith(b"\xff\xd8") or not result.stdout.endswith(b"\xff\xd9"):
        raise AssertionError("fixture encoder did not emit a complete JPEG-LS stream")
    return result.stdout, raw


def eager_trial(args, name, bits, width, height, chunk, stream, raw, fragmented=False):
    command = [str(args.binary), "decode", "-", "-", "raw-le", str(chunk)]
    started = monotonic()
    with Popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE, bufsize=0) as process:
        try:
            fragments = send_prefix(process, stream[:-2], fragmented, args.timeout)
            before_eoi, err1 = observe(process, args.observation_seconds)
            eoi_sent = monotonic() - started
            process.stdin.write(stream[-2:])
            process.stdin.flush()
            between, err2 = observe(process, args.observation_seconds)
            waited_for_eof = process.poll() is None
            process.stdin.close()
            process.stdin = None
            stdin_closed = monotonic() - started
            after, err3 = process.communicate(timeout=args.timeout)
            code = process.returncode
        finally:
            cleanup(process)
    stderr = err1 + err2 + err3
    high_water = re.search(rb"\binput_high_water=(\d+)\b", stderr)
    input_peak = int(high_water[1]) if high_water else None
    short_read_ok = not fragmented or input_peak is not None and input_peak <= max(fragments + [2])
    exact = before_eoi + between + after == raw
    return {
        "case": name, "command": command, "bits": bits, "width": width, "height": height,
        "cliChunkBytes": chunk, "rowBytes": width * (1 if bits == 8 else 2),
        "streamSha256": sha256(stream).hexdigest(), "expectedOutputBytes": len(raw),
        "prefixFragmentBytes": fragments, "inputHighWaterBytes": input_peak,
        "outputBeforeEoiBytes": len(before_eoi), "outputBetweenEoiAndEofBytes": len(between),
        "outputAfterEofBytes": len(after), "waitedForStdinEof": waited_for_eof,
        "eoiSentSeconds": eoi_sent, "stdinClosedSeconds": stdin_closed,
        "outputExact": exact, "exitCode": code, "stderr": stderr.decode(errors="replace"),
        "passed": exact and before_eoi == raw and not between and not after and
                  waited_for_eof and code == 0 and short_read_ok,
    }


def late_tail_trial(args, chunk):
    stream, raw = fixed_zero_stream(8)
    command = [str(args.binary), "decode", "-", "-", "raw-le", str(chunk)]
    with Popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE, bufsize=0) as process:
        try:
            process.stdin.write(stream)
            process.stdin.flush()
            before, err1 = observe(process, args.observation_seconds)
            waited_for_eof = process.poll() is None
            process.stdin.write(b"\x00")
            process.stdin.close()
            process.stdin = None
            after, err2 = process.communicate(timeout=args.timeout)
            code = process.returncode
        finally:
            cleanup(process)
    stderr = err1 + err2
    return {"case": "late-tail", "cliChunkBytes": chunk,
            "outputBeforeLateTailBytes": len(before), "outputAfterLateTailBytes": len(after),
            "waitedForStdinEof": waited_for_eof, "exitCode": code,
            "stderr": stderr.decode(errors="replace"),
            "passed": before == raw and not after and waited_for_eof and code != 0 and
                      b"CommandError.Input" in stderr}


def blocked_sink_trial(args, encoder):
    stream, raw = make_zero_stream(encoder, 4096, 16, 16, args.timeout)
    command = [str(args.binary), "decode", "-", "-", "raw-le", "4096"]
    with Popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE, bufsize=0) as process:
        try:
            fcntl.fcntl(process.stdout.fileno(), fcntl.F_SETPIPE_SZ, 4096)
            capacity = fcntl.fcntl(process.stdout.fileno(), fcntl.F_GETPIPE_SZ)
            if len(raw) <= capacity:
                raise AssertionError("fixture must exceed the output pipe's capacity")
            process.stdin.write(stream)
            process.stdin.close()
            process.stdin = None
            deadline = monotonic() + args.timeout
            while queued(process.stdout.fileno()) < capacity:
                if process.poll() is not None or monotonic() >= deadline:
                    raise TimeoutError("output pipe did not reach the backpressure gate")
                sleep(0.002)
            before = queued(process.stdout.fileno())
            hold_started = monotonic()
            sleep(0.1)
            hold_seconds = monotonic() - hold_started
            during = queued(process.stdout.fileno())
            running_while_held = process.poll() is None
            stdout, stderr = process.communicate(timeout=args.timeout)
            code = process.returncode
        finally:
            cleanup(process)
    return {"case": "blocked-output-resumes", "cliChunkBytes": 4096,
            "stdoutPipeCapacityBytes": capacity, "queuedBeforeHoldBytes": before,
            "queuedAfterHoldBytes": during, "holdSeconds": hold_seconds,
            "runningWhileHeld": running_while_held, "expectedOutputBytes": len(raw),
            "actualOutputBytes": len(stdout), "outputExact": stdout == raw, "exitCode": code,
            "stderr": stderr.decode(errors="replace"),
            "passed": before == capacity and during == before and running_while_held and
                      stdout == raw and code == 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--fixture-encoder", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--observation-seconds", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    args.binary = args.binary.resolve(strict=True)
    encoder = (args.fixture_encoder or args.binary).resolve(strict=True)
    if args.observation_seconds <= 0 or args.timeout <= 0:
        parser.error("timing budgets must be positive")
    report = {"binary": str(args.binary), "binarySha256": digest(args.binary),
              "fixtureEncoder": str(encoder), "fixtureEncoderSha256": digest(encoder),
              "observationSecondsPerGate": args.observation_seconds,
              "scope": "Native CLI correctness and liveness; no throughput measurement", "trials": []}
    for bits in (8, 16):
        stream, raw = fixed_zero_stream(bits)
        for chunk in (1, 4096, 65536):
            report["trials"].append(eager_trial(args, "narrow-row", bits, 1, 4, chunk, stream, raw))
    for chunk in (4096, 65536):
        width = chunk // 2 + 1
        stream, raw = make_zero_stream(encoder, width, 2, 16, args.timeout)
        report["trials"].append(eager_trial(args, "row-wider-than-output-buffer", 16, width, 2,
                                            chunk, stream, raw))
    stream, raw = fixed_zero_stream(16)
    report["trials"].append(eager_trial(args, "short-input-reads", 16, 1, 4, 4096,
                                        stream, raw, fragmented=True))
    for chunk in (4096, 65536):
        report["trials"].append(late_tail_trial(args, chunk))
    report["trials"].append(blocked_sink_trial(args, encoder))
    report["passed"] = all(trial["passed"] for trial in report["trials"])
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
