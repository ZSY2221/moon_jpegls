"""Run the three RC3 Native direct-file controls with an observed pipe drain."""

import argparse
from array import array
from collections import Counter
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import selectors
from subprocess import DEVNULL, PIPE, Popen
from termios import FIONREAD
from time import monotonic


WIDTH = 512
HEIGHT = 4096
ROW_BYTES = WIDTH * 2
OUTPUT_BYTES = ROW_BYTES * HEIGHT
HOST_READ_BYTES = 65536
STARTUP_MARGIN_SECONDS = 5.0


def digest(path):
    hash_file = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hash_file.update(chunk)
    return hash_file.hexdigest()


def proc_io(pid):
    try:
        return {name: int(value) for name, value in
                (line.split(":") for line in Path(f"/proc/{pid}/io").read_text().splitlines())}
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return None


def pipe_queued(fd):
    value = array("i", [0])
    fcntl.ioctl(fd, FIONREAD, value, True)
    return value[0]


def run_case(args, case, chunk, pause_seconds, deadline_seconds, budget_basis):
    command = [str(args.binary), "decode", str(args.fixture), "-", "raw-le", str(chunk)]
    events = {"parentStdinClosedBeforeSpawn": 0.0}
    output_bytes = error_bytes = 0
    last_progress = None
    output_hash = sha256()
    stderr = bytearray()
    read_sizes = Counter()
    mismatch = None
    timeout = False
    paused_until = None
    pause_pending = pause_seconds > 0
    started = monotonic()
    next_summary = 0.0
    last_io = None
    progress = []

    def event(name):
        events.setdefault(name, monotonic() - started)

    with Popen(command, stdin=DEVNULL, stdout=PIPE, stderr=PIPE, bufsize=0) as process, \
            selectors.DefaultSelector() as selector, args.reference.open("rb") as reference:
        event("spawned")
        capacity = fcntl.fcntl(process.stdout.fileno(), fcntl.F_GETPIPE_SZ)
        for stream in (process.stdout, process.stderr):
            os.set_blocking(stream.fileno(), False)
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        if not pause_pending:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        try:
            while selector.get_map() or pause_pending or paused_until is not None or process.poll() is None:
                elapsed = monotonic() - started
                if elapsed >= deadline_seconds and not timeout and process.poll() is None:
                    timeout = True
                    process.kill()
                    event("timedOutAndKilled")
                if pause_pending:
                    if pipe_queued(process.stdout.fileno()) >= capacity - 8:
                        event("fullPipeObserved")
                        paused_until = monotonic() + pause_seconds
                        pause_pending = False
                    elif elapsed >= STARTUP_MARGIN_SECONDS or process.poll() is not None:
                        event("holdTriggerNotReached")
                        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
                        pause_pending = False
                if paused_until is not None and monotonic() >= paused_until:
                    event("drainStartedAfterHold")
                    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
                    paused_until = None
                if elapsed >= next_summary:
                    last_io = proc_io(process.pid)
                    progress.append({"elapsedSeconds": elapsed, "stdoutBytes": output_bytes,
                                     "completeRows": output_bytes // ROW_BYTES, "stderrBytes": error_bytes,
                                     "lastOutputProgressSeconds": last_progress,
                                     "pauseState": "waiting-for-full-pipe" if pause_pending else
                                         "held" if paused_until is not None else "draining",
                                     "stdinWriteBytes": 0, "stdinFeedBlocked": False,
                                     "processExitCode": process.poll(), "procIo": last_io})
                    next_summary = elapsed + 1
                if process.poll() is not None:
                    event("exitObserved")
                sleep_limit = 0.01 if pause_pending or paused_until is not None else 0.1
                if paused_until is not None:
                    sleep_limit = min(sleep_limit, max(0, paused_until - monotonic()))
                for key, _ in selector.select(sleep_limit):
                    try:
                        data = os.read(key.fd, HOST_READ_BYTES)
                    except BlockingIOError:
                        continue
                    channel = key.data
                    if not data:
                        event(f"{channel}Eof")
                        selector.unregister(key.fileobj)
                        continue
                    if channel == "stderr":
                        error_bytes += len(data)
                        stderr.extend(data)
                        continue
                    if output_bytes == 0:
                        event("firstOutputByte")
                    output_hash.update(data)
                    expected = reference.read(len(data))
                    if mismatch is None and data != expected:
                        difference = next((index for index, (left, right) in enumerate(zip(data, expected))
                                           if left != right), len(expected))
                        mismatch = output_bytes + difference
                    output_bytes += len(data)
                    read_sizes[len(data)] += 1
                    last_progress = monotonic() - started
                    if output_bytes >= ROW_BYTES:
                        event("firstCompleteRow")
                    if output_bytes >= OUTPUT_BYTES:
                        event("allExpectedOutputReceived")
            event("exitObserved")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    resumed = events.get("drainStartedAfterHold")
    hold = resumed - events["fullPipeObserved"] if resumed is not None else 0
    exact = mismatch is None and output_bytes == OUTPUT_BYTES and output_hash.hexdigest() == args.reference_sha256
    completed = (not timeout and exact and process.returncode == 0 and
                 "stdoutEof" in events and "stderrEof" in events and
                 (not pause_seconds or resumed is not None))
    return {
        "case": case, "command": command, "cliChunkBytes": chunk,
        "deadlineSecondsFromSpawnAttempt": deadline_seconds, "budgetBasis": budget_basis,
        "stdoutPipeCapacityBytes": capacity, "hostStdoutReadLimitBytes": HOST_READ_BYTES,
        "hostStderrReadLimitBytes": HOST_READ_BYTES, "parentInputMode": "direct child file input; stdin is /dev/null",
        "parentStdinWriteBytes": 0, "parentStdinWriteGranularityBytes": None,
        "plannedPauseSeconds": pause_seconds, "actualFullPipeHoldSeconds": hold,
        "elapsedSeconds": events["exitObserved"], "eventsSecondsFromSpawnAttempt": events,
        "stdoutBytes": output_bytes, "completeRows": output_bytes // ROW_BYTES,
        "hostStdoutReadCalls": read_sizes.total(), "hostStdoutReadSizeMin": min(read_sizes, default=0),
        "hostStdoutReadSizeMax": max(read_sizes, default=0), "stderrBytes": error_bytes,
        "stderr": stderr.decode(errors="replace"), "reconstructionSha256": output_hash.hexdigest(),
        "matchesReferenceByteForByte": exact, "firstDifferenceByte": mismatch,
        "exitCode": process.returncode, "timedOut": timeout, "completed": completed,
        "processIoNote": "Linux /proc counters are diagnostic totals, not a parser's input/EOI milestones.",
        "progressAtMostOncePerSecond": progress,
    }


def operation_count(chunks, compressed_bytes):
    # Native takes floor(CHUNK / 2) samples per sink.write for 16-bit raw.
    writes_per_row = math.ceil(WIDTH / (chunks // 2))
    return writes_per_row * HEIGHT + math.ceil(compressed_bytes / chunks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--binary-sha256", required=True)
    parser.add_argument("--fixture-sha256", required=True)
    parser.add_argument("--reference-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    for label in ("binary", "fixture", "reference"):
        actual = digest(getattr(args, label))
        if actual != getattr(args, f"{label}_sha256"):
            raise SystemExit(f"{label} SHA-256 mismatch: {actual}")
    assert args.reference.stat().st_size == OUTPUT_BYTES
    compressed_bytes = args.fixture.stat().st_size
    report = {
        "recordedUtc": datetime.now(timezone.utc).isoformat(), "sourceCommit": args.source_commit,
        "binarySha256": args.binary_sha256, "fixtureSha256": args.fixture_sha256,
        "referenceSha256": args.reference_sha256,
        "width": WIDTH, "height": HEIGHT, "bits": 16, "near": 0, "direction": "decode",
        "compressedBytes": compressed_bytes, "expectedRawBytes": OUTPUT_BYTES,
        "caseSchedule": ["A - 4096 fast", "B - 7 fast", "C - 7 once-held"], "results": [],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def add(result):
        report["results"].append(result)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps({name: result[name] for name in ("case", "elapsedSeconds", "stdoutBytes", "completed", "timedOut")}), flush=True)

    fast = run_case(args, "A", 4096, 0, 20, "Initial known-fast control budget, not the historical seven-byte drain limit")
    add(fast)
    if not fast["completed"]:
        return 1
    ratio = operation_count(7, compressed_bytes) / operation_count(4096, compressed_bytes)
    small_chunk_estimate = fast["elapsedSeconds"] * ratio
    budget = 2 * small_chunk_estimate + STARTUP_MARGIN_SECONDS
    small = run_case(args, "B", 7, 0, budget,
                     {"fastControlSeconds": fast["elapsedSeconds"], "estimatedIoCallRatio": ratio,
                      "estimatedFastForSmallChunksSeconds": small_chunk_estimate,
                      "doubleEstimatePlusMarginSeconds": budget,
                      "note": "Deliberately conservative management estimate, not an attribution model"})
    add(small)
    if not small["completed"]:
        return 1
    pause = 0.1
    budget = 2 * small["elapsedSeconds"] + pause + STARTUP_MARGIN_SECONDS
    held = run_case(args, "C", 7, pause, budget,
                    {"fastControlSeconds": small["elapsedSeconds"], "inputPlannedWaitSeconds": 0,
                     "outputPlannedWaitSeconds": pause, "startupAndTeardownMarginSeconds": STARTUP_MARGIN_SECONDS})
    add(held)
    return 0 if held["completed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
