"""Fetch and verify the official ITU-T T.87 Annex E vectors."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_URL = "https://www.itu.int/rec/dologin_pub.asp?id=T-REC-T.87-199806-I%21%21ZPF-E&lang=e&type=items"
BUNDLE_SIZE = 1_779_280
BUNDLE_SHA256 = "c54f20d167485399d2094d3375151d2ec31535d4c32d92fb929b15fc364ea41a"
SOFTWARE_NAME = "software/T87/Software.zip"
SOFTWARE_SHA256 = "a96fc46088e0ea89b17eea7d14fa909fe3a5c6c934c6f5d63e03076bb5eae889"


def download_bundle():
    for attempt in range(3):
        try:
            with urlopen(BUNDLE_URL, timeout=30) as response:
                return response.read(BUNDLE_SIZE + 1)
        except (URLError, TimeoutError, OSError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def checked(data, name, expected):
    sha256 = hashlib.sha256(data).hexdigest()
    if sha256 != expected["sha256"] or len(data) != expected.get("bytes", len(data)):
        raise ValueError(f"{name}: unexpected SHA-256 {sha256} or size {len(data)}")
    return data


def archive_member(blob, name, expected):
    with ZipFile(io.BytesIO(blob)) as archive:
        return checked(archive.read(name), name, expected)


def files_from_archive(blob, metadata):
    files = {}
    with ZipFile(io.BytesIO(blob)) as archive:
        for name, expected in metadata.items():
            if Path(name).name != name:
                raise ValueError(f"Expected a filename in the manifest: {name}")
            files[name] = checked(archive.read(name), name, expected)
    return files


def stage(files, directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        existing = directory / name
        if existing.exists() and existing.read_bytes() != data:
            raise ValueError(f"Existing file differs from the verified member: {existing}")
    for name, data in files.items():
        destination = directory / name
        if not destination.exists():
            with destination.open("xb") as output:
                output.write(data)
    return {"path": str(directory), "verifiedFiles": len(files)}


def prepare(args, receipt):
    raw = args.bundle.read_bytes() if args.bundle else download_bundle()
    checked(raw, "ITU-T T.87 PDF ZIP bundle", {"bytes": BUNDLE_SIZE, "sha256": BUNDLE_SHA256})
    software = archive_member(raw, SOFTWARE_NAME, {"sha256": SOFTWARE_SHA256})
    manifest = json.loads((ROOT / "tests/conformance/manifest.json").read_text(encoding="utf8"))
    vectors = manifest["fixtureArchive"]
    archive = archive_member(software, f"software/T87/{vectors['name']}", vectors)
    metadata = {**manifest["sourceFiles"], **{item["file"]: item for item in manifest["cases"]}}
    receipt["fixtures"] = {**stage(files_from_archive(archive, metadata), args.fixtures), "sha256": vectors["sha256"]}
    if args.hp_reference:
        reference = manifest["officialReference"]
        archive = archive_member(software, f"software/T87/{reference['name']}", reference)
        receipt["hpReference"] = {
            **stage(files_from_archive(archive, reference["files"]), args.hp_reference), "sha256": reference["sha256"],
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, help="Use a local copy of the official ITU PDF ZIP")
    parser.add_argument("--fixtures", type=Path, default=Path(".tools/annex-e"))
    parser.add_argument("--hp-reference", type=Path, help="Also extract the pinned HP decoder executables for local testing")
    args = parser.parse_args()
    receipt = {"url": BUNDLE_URL, "bundleSha256": BUNDLE_SHA256, "softwareSha256": SOFTWARE_SHA256,
               "localBundle": str(args.bundle) if args.bundle else None}
    try:
        prepare(args, receipt)
        receipt.update(status="passed", exitCode=0)
    except (URLError, OSError) as error:
        receipt.update(status="blocked", message=str(error), exitCode=1)
    except (BadZipFile, KeyError, ValueError) as error:
        receipt.update(status="failed", message=str(error), exitCode=1)
    print(json.dumps(receipt, indent=2))
    if receipt["exitCode"]:
        print(f"Annex E fixtures {receipt['status']}: {receipt['message']}", file=sys.stderr)
    return receipt["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
