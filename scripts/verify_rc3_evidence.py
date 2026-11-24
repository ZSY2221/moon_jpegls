"""Recompute the RC3 timing gates from the archived raw samples."""

import argparse
import json
from math import isfinite
from pathlib import Path
from statistics import median
import subprocess


ROOT = Path(__file__).resolve().parents[1]
CONFIGS = [(backend, near) for backend in ("wasm-gc", "js") for near in (0, 3)]
LOADED = ("web/app.mjs", "web/pgm.mjs", "web/preview.mjs", "sdk/index.mjs", "sdk/worker-client.mjs",
          "sdk/worker.mjs", "sdk/generated/core.mjs", "sdk/generated/core.wasm")


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def samples(report, variant, config, field):
    backend, near = config
    selected = [trial for trial in report["trials"]
                if (trial["variant"], trial["backend"], trial["near"]) == (variant, backend, near)]
    assert sorted((trial["phase"], trial["index"]) for trial in selected) == [
        *(('formal', i) for i in range(1, 6)), ('warmup', 1), ('warmup', 2),
    ], (variant, config)
    values = [trial[field] for trial in sorted(selected, key=lambda row: row["index"]) if trial["phase"] == "formal"]
    assert all(isinstance(value, (int, float)) and isfinite(value) and value >= 0 for value in values), (variant, config, field)
    return values


def check_assets(paired):
    assets = paired["assets"]
    receipts = paired["actualBrowserResponses"]
    for variant in ("baseline", "candidate"):
        for path in LOADED:
            delivered = receipts[f"/{variant}/{path}"]
            expected = assets[variant][path]["sha256"]
            assert delivered["deliveredSha256"] == expected, (variant, path)
            if delivered["browserBodySha256"] is not None:
                assert delivered["browserBodySha256"] == expected, (variant, path)
    changed = {path for path in assets["baseline"]
               if assets["baseline"][path]["originalSha256"] != assets["candidate"][path]["originalSha256"]}
    assert changed == {"web/app.mjs", "web/pgm.mjs"}, changed
    return sorted(changed)


def check_workbench(rc3, paired):
    encoded_bytes = {0: 1_249_961, 3: 594_831}
    for trial in paired["trials"]:
        workers = {item["mode"]: item["stats"] for item in trial["workers"]}
        encode, decode = workers["encode"], workers["decode"]
        assert trial["status"] == "Complete" and trial["progress"] == 4096 and not trial["downloadVisible"]
        assert int(trial["maxError"]) <= trial["near"]
        assert encode["inputConsumed"] == decode["outputProduced"] == 512 * 4096
        assert encode["outputProduced"] == decode["inputConsumed"] == encoded_bytes[trial["near"]]
        assert encode["rows"] == decode["rows"] == 4096
        assert decode["inputQueueBytes"] == decode["outputQueueBytes"] == 0

    memory = load(rc3 / "workbench-memory.json")
    short = load(rc3 / "workbench-memory-short.json")
    assert memory["diagnostic"] and short["diagnostic"] and not (memory["failures"] or short["failures"])
    assert (short["fixture"]["width"], short["fixture"]["height"]) == (512, 128)
    before, after = (trial["diagnostic"] for trial in memory["trials"])
    short_diagnostic = short["trials"][0]["diagnostic"]
    assert before["referenceCachePeakBytes"] == 0
    for profile, height in ((after, 4096), (short_diagnostic, 128)):
        reference = profile["reference"]
        assert profile["referenceCachePeakBytes"] == 65536
        assert reference["peakRawAndMaterializedBytes"] == 65536 + 1024
        assert reference["requests"] == reference["materializeCalls"] == profile["comparison"]["calls"] == height
        assert reference["blobBytes"] == height * 1024
        assert reference["blobReads"] == 1 + (height - 1 + 63) // 64

    download = load(rc3 / "workbench-real-download.json")["download"]
    assert download["sameStreamReferenceMatch"] and download["samplesChecked"] == 1440 * 720
    assert download["maxError"] <= 3
    receipt = load(rc3 / "chrome-smoke.json")["responses"]
    for path in LOADED:
        assert receipt[f"/{path}"]["sha256"] == paired["assets"]["candidate"][path]["originalSha256"]
    smoke = [json.loads(line) for line in (rc3 / "chrome-smoke.txt").read_text(encoding="utf-8").splitlines()]
    restart = {event["blocked"]: event for event in smoke if event.get("test") == "browser cancel/restart with pending host operation"}
    assert set(restart) == {"read", "write"} and all(event["newPixel"] == 4000 for event in restart.values())
    assert restart["read"]["reads"]["old"][0]["bytes"] == 8
    pause = next(event for event in smoke if event.get("test") == "worker ACK, manual resume and one-byte reads")
    assert pause["before"] == pause["whileHeld"] == pause["whilePaused"] and pause["rows"] == pause["expected"]
    assert smoke[-1]["status"] == "passed"
    return {"rowsPerTrial": 4096, "samplesPerTrial": 512 * 4096,
            "referenceBlobReads": [before["reference"]["blobReads"], after["reference"]["blobReads"]],
            "referenceCachePeakBytes": after["referenceCachePeakBytes"], "downloadSamples": download["samplesChecked"],
            "pendingWindowAndSinkCancellation": True, "stablePauseAndAck": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports", type=Path, default=ROOT / "reports")
    args = parser.parse_args()
    base = args.reports.resolve()
    rc3 = base / "rc3"
    rc2 = json.loads(subprocess.check_output(
        ["node", "scripts/analyze_worker_bench.mjs", str(base / "rc2" / "worker-paired.json")], cwd=ROOT,
    ))
    assert rc2 == load(base / "rc2" / "worker-gates.json")
    original = load(rc3 / "native-rc2-original.json")
    native = load(rc3 / "native-controls.json")
    assert native["binarySha256"] == original["binarySha256"]
    assert native["fixtureSha256"] == original["fixtureSha256"]
    assert original["actualReceivedBytesAtTimeout"] is None
    assert [trial["case"] for trial in native["results"]] == ["A", "B", "C"]
    assert all(trial["completed"] and trial["exitCode"] == 0 and trial["stdoutBytes"] == 4194304
               and trial["matchesReferenceByteForByte"] for trial in native["results"])
    assert native["results"][1]["elapsedSeconds"] > original["drainTimeoutSeconds"]
    assert native["results"][2]["actualFullPipeHoldSeconds"] >= 0.1
    eager = load(rc3 / "native-eager.json")
    assert eager["rowsBeforeEoi"] == 4 and eager["rowsAfterEoi"] == 0 and eager["finalSamplesMatch"]
    tail = load(rc3 / "native-tail.json")
    assert len(tail["trials"]) == 20 and tail["lateTrailingDataWhileInputOpen"] == "rejected"

    profile = load(rc3 / "workbench-profile.json")
    assert profile["diagnostic"] and len(profile["trials"]) == 28 and not profile["failures"]
    reads = [trial["diagnostic"]["reference"]["blobReads"] for trial in profile["trials"]]
    assert all(count == profile["fixture"]["height"] for count in reads)
    eligibility = median(trial["diagnostic"]["referenceIoAndMaterializationShare"] for trial in profile["trials"]
                         if trial["backend"] == "wasm-gc" and trial["near"] == 0 and trial["phase"] == "formal")
    assert eligibility >= 0.20

    paired = load(rc3 / "workbench-paired.json")
    assert not paired["diagnostic"] and not paired["failures"] and len(paired["trials"]) == 56
    assert (paired["fixture"]["width"], paired["fixture"]["height"], paired["fixture"]["bits"]) == (512, 4096, 16)
    assert paired["fixture"]["sha256"] == profile["fixture"]["sha256"]
    changed = check_assets(paired)
    workbench = check_workbench(rc3, paired)
    cases = []
    for config in CONFIGS:
        before, after = (samples(paired, variant, config, "wallMs") for variant in ("baseline", "candidate"))
        first_before, first_after = (median(samples(paired, variant, config, "firstDisplayMs"))
                                     for variant in ("baseline", "candidate"))
        before_ms, after_ms = median(before), median(after)
        reduction = 100 * (1 - after_ms / before_ms)
        stable_regression = after_ms > before_ms * 1.05 and sum(b > a * 1.05 for a, b in zip(before, after)) >= 4
        wall_pass = reduction >= 10 if config == ("wasm-gc", 0) else not stable_regression
        first_pass = first_after <= first_before + max(2, first_before * 0.10)
        cases.append({"backend": config[0], "near": config[1], "wallMs": [before_ms, after_ms],
                      "reductionPercent": reduction, "firstDisplayMs": [first_before, first_after],
                      "wallPass": wall_pass, "firstDisplayPass": first_pass})
    timing_pass = all(item["wallPass"] and item["firstDisplayPass"] for item in cases)
    assert timing_pass and paired["gate"]["timingPass"]
    print(json.dumps({"rc2WorkerCases": len(rc2["results"]), "nativeControls": len(native["results"]),
                      "referenceIoAndMaterializationShare": eligibility,
                      "changedProductAssets": changed, "timingPass": timing_pass, "cases": cases,
                      "workbenchChecks": workbench}, indent=2))


if __name__ == "__main__":
    main()
