"""Export the tested workbench, browser receipts, screenshots and sealed RC3 evidence."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from make_rc3_review import REQUIRED, ROOT, git, make_zip


PRESENTATION = "reports/presentation"
BASELINE = "2feb00b8ef657b7259ba70bccf1ff0ceaf08765b"
FROZEN = ("core", "cmd", "sdk", "web/pgm.mjs", "web/transport.mjs")
REQUIRED_FILES = REQUIRED | {
    "docs/PRESENTATION_HANDOFF.md", "reports/rc3/harness/README.md", "web/smoke.mjs",
    "web/bench-presentation.mjs", "web/preview-browser.mjs", "web/capture-presentation.mjs",
    *(f"{PRESENTATION}/{name}" for name in ("README.md", "manifest.json", "paired.json", "candidate-smoke.txt",
       "screens/baseline-1440.png", "screens/desktop-en.png", "screens/desktop-zh.png", "screens/narrow-390.png",
       "screens/finalizing.png", "screens/failed.png")),
}


def entry_note(head, tested, changed):
    return f"""# MoonJLS workbench presentation review

- Export revision `{head}`
- Tested source `{tested}`
- Fixed RC3 baseline `{BASELINE}`

The export adds documentation and recorded evidence after the tested source.

## Start here

- [90-second operation sequence and handoff](docs/PRESENTATION_HANDOFF.md)
- [Browser checks, screenshots and paired performance guard](reports/presentation/README.md)
- [Source, build and receipt SHA-256 inventory](reports/presentation/manifest.json)
- [Sealed RC3 findings](reports/rc3/README.md) and [historical harness supplement](reports/rc3/harness/README.md)

From the extracted root run `npm ci --prefix web`, `node sdk/build.mjs` and `node web/build.mjs`.
Serve `web/dist` with `python -m http.server 8000 --bind 127.0.0.1 --directory web/dist` and open `/web/`.
The full instructions include offline evidence checks and the smoke test. This ZIP contains source and evidence.
Generated codec assets and large images can be reproduced using the documented toolchain and fixture commands.

`SHA256SUMS.txt` covers the other entries. The detached checksum covers the ZIP itself.
""".encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".tools/review/MoonJLS-Presentation-Review.zip")
    args = parser.parse_args()
    manifest = json.loads((ROOT / PRESENTATION / "manifest.json").read_text(encoding="utf-8"))
    tested = manifest["testedSource"]
    if manifest["baselineSource"] != BASELINE or git("diff", "--name-only", BASELINE, tested, "--", *FROZEN):
        raise SystemExit("Presentation source changed a frozen RC3 path")
    for name, record in manifest["evidenceFiles"].items():
        if sha256((ROOT / PRESENTATION / name).read_bytes()).hexdigest() != record["sha256"]:
            raise SystemExit(f"Evidence differs from the recorded hash: {name}")
    make_zip(args.output.resolve(), tested, required=REQUIRED_FILES, note=entry_note)


if __name__ == "__main__":
    main()
