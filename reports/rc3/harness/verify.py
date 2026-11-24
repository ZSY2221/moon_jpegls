"""Verify the sealed RC3 gates and archived harness source hashes."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from zipfile import ZipFile


ARCHIVE = Path(__file__).resolve().parent
REPORTS = ARCHIVE.parent
ROOT = REPORTS.parents[1]
RECEIPTS = {
    "workbench-profile.json",
    "workbench-paired.json",
    "workbench-memory.json",
    "workbench-memory-short.json",
    "workbench-real-download.json",
}


def read_json(path):
    return json.loads(path.read_bytes())


def digest(content):
    return sha256(content).hexdigest()


def check_harness():
    manifest = read_json(ARCHIVE / "manifest.json")
    assert manifest["schema"] == 1
    archived = {}
    for item in manifest["archived"]:
        assert Path(item["file"]).name == item["file"], item["file"]
        content = (ARCHIVE / item["file"]).read_bytes()
        assert len(content) == item["bytes"], item["file"]
        assert digest(content) == item["sha256"], item["file"]
        key = (item["kind"], item["sha256"])
        assert key not in archived, key
        archived[key] = item["file"]
    missing = {(item["kind"], item["sha256"]) for item in manifest["notArchived"]}
    assert set(archived).isdisjoint(missing)
    assert set(manifest["reports"]) == RECEIPTS
    assert set(archived.values()) == {path.name for path in ARCHIVE.glob("*.mjs")}

    sealed_hashes = read_json(REPORTS / "manifest.json")["rawEvidenceSha256"]
    used = set()
    for filename, evidence in manifest["reports"].items():
        content = (REPORTS / filename).read_bytes()
        assert digest(content) == sealed_hashes[filename], filename
        receipt = json.loads(content)
        assert evidence == {**receipt["harness"], "sourceCommit": receipt["sourceCommit"]}, filename
        for kind in ("runner", "probe"):
            used.add((kind, evidence[kind + "Sha256"]))
    assert used == set(archived) | missing
    return {"reports": len(RECEIPTS), "archivedTexts": len(archived), "unarchivedTexts": len(missing)}


def check_zip(path):
    with ZipFile(path) as archive:
        members = archive.namelist()
        assert len(members) == len(set(members)), "Duplicate ZIP member"
        assert archive.testzip() is None, "ZIP CRC mismatch"
        lines = archive.read("SHA256SUMS.txt").decode("utf-8").splitlines()
        hashes = dict((name, sha) for sha, name in (line.split("  ", 1) for line in lines))
        assert len(hashes) == len(lines) and set(hashes) == set(members) - {"SHA256SUMS.txt"}
        for name, expected in hashes.items():
            assert digest(archive.read(name)) == expected, name
        for file in (*ARCHIVE.glob("*.mjs"), ARCHIVE / "manifest.json"):
            assert hashes[file.relative_to(ROOT).as_posix()] == digest(file.read_bytes()), file.name
        for filename in RECEIPTS:
            file = REPORTS / filename
            assert hashes[file.relative_to(ROOT).as_posix()] == digest(file.read_bytes()), filename
    detached = path.with_suffix(".zip.sha256").read_text(encoding="ascii").split()
    assert detached == [digest(path.read_bytes()), path.name], path.name
    return len(members)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, help="also verify the ZIP member inventory and detached SHA-256")
    args = parser.parse_args()
    result = check_harness()
    gates = json.loads(subprocess.check_output(
        [sys.executable, str(ROOT / "scripts/verify_rc3_evidence.py")], cwd=ROOT,
    ))
    assert gates == read_json(REPORTS / "workbench-gates.json")
    result["sealedGatesMatch"] = True
    if args.zip:
        result["zipMembers"] = check_zip(args.zip.resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
