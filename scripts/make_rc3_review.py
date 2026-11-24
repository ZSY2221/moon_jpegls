"""Export the tested MoonJLS source and review evidence without build caches."""

import argparse
from copy import copy
from hashlib import sha256
from io import BytesIO
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
from urllib.parse import unquote, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r"\]\((<[^>]+>|[^)\s]+)\)")
EXCLUDED = {".git", ".tools", ".evidence", "node_modules", "_build", ".mooncakes", "__pycache__"}
REQUIRED = {
    "moon.mod", "docs/RC3_HANDOFF.md", "reports/rc3/README.md", "web/bench-workbench.mjs",
    "REVIEW_EVIDENCE/rc3_native_slowcase_original.py", "reports/rc3/native-rc2-timeout.txt",
    "reports/rc3/native-controls.json", "reports/rc3/workbench-profile.json", "reports/rc3/workbench-paired.json",
    "reports/rc3/external-consumer.json",
    "reports/rc2/build.json", "reports/rc2/manifest.json", "reports/rc2/host-regressions.json",
    "reports/rc2/worker-paired.json", "reports/rc2/worker-gates.json", "reports/rc2/worker-builds.json",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def entry_note(head, tested, changed):
    after = "\n".join(f"- `{path}`" for path in changed) or "No later report changes."
    return f"""# MoonJLS RC3 review

- Repository HEAD at export `{head}`
- Tested RC3 source `{tested}`
- RC2 measured source `a146998f31675769fb6c3bc9055ef7798f254b1d`

Changes between the tested source and export are limited to documentation and evidence.

{after}

## Start here

- [RC3 findings, actual runs and commands](reports/rc3/README.md)
- [Fixed-source Antigravity handoff](docs/RC3_HANDOFF.md)
- [RC2 reports and original Worker samples](reports/rc2/README.md)
- [Validation fixtures and oracle setup](docs/VALIDATION.md)

Build the SDK with `node sdk/build.mjs` and the workbench with `node web/build.mjs` from the extracted root. Start it with `python -m http.server 8000 --bind 127.0.0.1 --directory web/dist`, then open the `/web/` page. The archive includes the MoonBit source, browser and SDK source, test drivers, fixed dependency manifests and recorded evidence. The toolchain, generated assets and large input images are regenerated or fetched using the documented commands.

`SHA256SUMS.txt` covers all other entries in this archive. The detached `.sha256` file covers the ZIP itself.
""".encode("utf-8")


def validate_links(contents):
    names = set(contents)
    for file, data in contents.items():
        if not file.endswith(".md"):
            continue
        for value in LINK.findall(data.decode("utf-8")):
            url = urlsplit(value.removeprefix("<").removesuffix(">"))
            if url.scheme or url.netloc or not url.path:
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(file), unquote(url.path)))
            if target not in names and not any(name.startswith(target + "/") for name in names):
                raise ValueError(f"Unresolved archive link: {file} -> {value}")


def make_zip(output, tested):
    head = git("rev-parse", "HEAD").decode().strip()
    tested = git("rev-parse", f"{tested}^{{commit}}").decode().strip()
    subprocess.run(["git", "merge-base", "--is-ancestor", tested, head], cwd=ROOT, check=True)
    changed = git("diff", "--name-only", tested, head).decode().splitlines()
    if any(not path.startswith(("docs/", "reports/")) and path != "PROJECT_STATUS.md" for path in changed):
        raise ValueError("Export includes non-evidence changes after the tested source")
    if git("status", "--porcelain"):
        raise ValueError("Commit the source and evidence before export")

    tracked = {}
    with ZipFile(BytesIO(git("archive", "--format=zip", head))) as source:
        for info in source.infolist():
            name = info.filename
            parts = PurePosixPath(name).parts
            if info.is_dir():
                continue
            if EXCLUDED.intersection(parts) or name.startswith(("sdk/generated/", "web/dist/")):
                raise ValueError(f"Generated file tracked in project: {name}")
            tracked[name] = (copy(info), source.read(name))
    if missing := REQUIRED - tracked.keys():
        raise ValueError(f"Missing required material: {sorted(missing)}")

    contents = {"00_READ_FIRST.md": entry_note(head, tested, changed)}
    contents.update({name: data for name, (_, data) in tracked.items()})
    validate_links(contents)
    sums = "".join(f"{sha256(data).hexdigest()}  {name}\n" for name, data in sorted(contents.items()))
    contents["SHA256SUMS.txt"] = sums.encode("utf-8")

    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_suffix(".zip.tmp")
    with ZipFile(staged, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in contents.items():
            info = tracked[name][0] if name in tracked else ZipInfo(name)
            archive.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    with ZipFile(staged) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(contents)
        for name, data in contents.items():
            assert archive.read(name) == data, name
    staged.replace(output)
    digest = sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".zip.sha256").write_text(f"{digest}  {output.name}\n", encoding="ascii", newline="\n")
    print(f"{output} | {len(contents)} files | {output.stat().st_size} bytes | SHA-256 {digest}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tested-source", required=True, help="Clean source commit used for the reported RC3 run")
    parser.add_argument("--output", type=Path, default=ROOT / ".tools/review/MoonJLS-RC3-Review.zip")
    args = parser.parse_args()
    make_zip(args.output.resolve(), args.tested_source)


if __name__ == "__main__":
    main()
