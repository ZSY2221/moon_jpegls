"""Build fresh MoonJLS binaries and record the source and loaded files for an evidence run."""

import argparse
from datetime import datetime, timezone
from hashlib import file_digest
import json
from pathlib import Path
import platform
from shlex import join
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATHS = ("core", "cmd", "sdk", "web", "scripts", "examples", "REVIEW_EVIDENCE", "moon.mod")
RUNTIME_FILES = ("core.mjs", "core.wasm")


def capture(args):
    result = subprocess.run(args, cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.decode("utf-8", errors="replace").replace("\x00", "").strip()


def path_label(path):
    return path.relative_to(ROOT).as_posix()


def sha256(path):
    with path.open("rb") as file:
        return file_digest(file, "sha256").hexdigest()


def inventory(files):
    return {path_label(path): sha256(path) for path in sorted(files)}


def source_snapshot():
    paths = subprocess.check_output(["git", "ls-files", "-z", "--", *SOURCE_PATHS], cwd=ROOT)
    files = [ROOT / name.decode("utf-8") for name in paths.split(b"\0") if name]
    return {
        "commit": capture(["git", "rev-parse", "HEAD"]),
        "status": capture(["git", "status", "--porcelain=v1", "--untracked-files=all"]),
        "participatingFiles": inventory(files),
    }


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def build(directory, distro):
    before = source_snapshot()
    if before["status"]:
        raise SystemExit("Use a clean checkout for candidate builds. Commit the participating source before measuring.")
    directory.mkdir(parents=True, exist_ok=False)
    targets = directory / "targets"
    commands = []

    def native_command(*args):
        if distro:
            return ["wsl", "-d", distro, "--exec", "bash", "-lc",
                    join(["env", "CC=clang", "/root/.moon/bin/moon", *args])]
        return ["moon", *args]

    def run(args):
        subprocess.run(args, cwd=ROOT, check=True)
        commands.append(args)

    generated = ROOT / "sdk" / "generated"
    generated.mkdir(exist_ok=True)
    for target, extension, output in (("js", "js", "core.mjs"), ("wasm-gc", "wasm", "core.wasm")):
        run(["moon", "build", "cmd/bridge", "--release", "--target", target, "--target-dir", path_label(targets)])
        shutil.copyfile(targets / target / "release" / "build" / "cmd" / "bridge" / f"bridge.{extension}", generated / output)
    run(native_command("build", "cmd/moonjls", "--release", "--target", "native", "--target-dir", path_label(targets)))
    native = targets / "native" / "release" / "build" / "cmd" / "moonjls" / "moonjls.exe"
    run(["node", "web/build.mjs"])
    static = directory / "static"
    shutil.copytree(ROOT / "web" / "dist", static)
    after = source_snapshot()
    if after != before:
        raise RuntimeError("Source changed during the build")
    runtime = [native, *(generated / name for name in RUNTIME_FILES)]
    static_files = [path for path in static.rglob("*") if path.is_file()]
    static_sdk = static / "sdk"
    if any(sha256(static_sdk / "generated" / name) != sha256(generated / name) for name in RUNTIME_FILES):
        raise RuntimeError("Static and direct SDK core exports differ")
    manifest = {
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "source": before,
        "host": platform.platform(),
        "tools": {
            "moon": capture(["moon", "version", "--all"]),
            "nativeMoon": capture(native_command("version", "--all")),
            "nativeCompiler": capture(["wsl", "-d", distro, "--exec", "clang", "--version"] if distro else ["cc", "--version"]),
            "nativeOs": capture(["wsl", "-d", distro, "--exec", "uname", "-a"]) if distro else platform.platform(),
            "node": capture(["node", "--version"]),
            "python": sys.version,
        },
        "commands": commands,
        "artifacts": inventory(runtime + static_files),
        "nativeBinary": path_label(native),
        "staticDirectory": path_label(static),
    }
    write_json(directory / "build.json", manifest)
    return manifest


def verify(manifest):
    if source_snapshot()["participatingFiles"] != manifest["source"]["participatingFiles"]:
        raise RuntimeError("Participating source differs from the build manifest")
    for relative, expected in manifest["artifacts"].items():
        if sha256(ROOT / relative) != expected:
            raise RuntimeError(f"Artifact changed: {relative}")


def record(manifest_path, output, files, browser_receipt):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    verify(manifest)
    wheel = Path(capture([sys.executable, "-c", "import imagecodecs._jpegls as m; print(m.__file__)"]))
    package = ROOT / ".tools" / "oracle-npm" / "node_modules" / "@team-charls" / "charls-wasm"
    wrapper = [package / name for name in ("package.json", "charlsjs.js", "charlsjs.wasm", "index.js",
                                          "jpegls-encoder.js", "jpegls-decoder.js", "jpegls-error.js")]
    browser = None
    if browser_receipt:
        browser = json.loads(browser_receipt.read_text(encoding="utf-8"))
        for url, receipt in browser["responses"].items():
            expected = manifest["artifacts"].get(manifest["staticDirectory"] + url)
            if expected is None or receipt.get("sha256") != expected:
                raise RuntimeError(f"The browser loaded a different artifact: {url}")
        files.append(browser_receipt)
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, {
        "buildManifest": {"path": path_label(manifest_path), "sha256": sha256(manifest_path)},
        "sourceCommit": manifest["source"]["commit"],
        "recordedUtc": datetime.now(timezone.utc).isoformat(),
        "oracle": {
            "native": json.loads(capture([sys.executable, "scripts/oracle.py", "self-test"])),
            "nativeExtension": {"name": wheel.name, "sha256": sha256(wheel)},
            "wasm": json.loads(capture(["node", "scripts/oracle.mjs", "--self-test"])),
            "wasmFiles": inventory(wrapper),
        },
        "evidenceFiles": inventory(file.resolve() for file in files),
        "browser": browser,
    })
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    build_args = modes.add_parser("build", help="build from a clean checkout into a fresh directory")
    build_args.add_argument("--directory", type=Path, required=True)
    build_args.add_argument("--native-wsl", help="Ubuntu distro with clang and Moon installed in /root/.moon")
    verify_args = modes.add_parser("verify", help="verify relevant source and built artifacts, even after report-only commits")
    verify_args.add_argument("manifest", type=Path)
    record_args = modes.add_parser("record", help="bind verified build, pinned oracle and measurement/fixture reports")
    record_args.add_argument("manifest", type=Path)
    record_args.add_argument("--output", type=Path, required=True)
    record_args.add_argument("--file", type=Path, action="append", required=True)
    record_args.add_argument("--browser-receipt", type=Path)
    args = parser.parse_args()
    if args.mode == "build":
        manifest = build(args.directory.resolve(), args.native_wsl)
    elif args.mode == "verify":
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        verify(manifest)
    else:
        manifest = record(args.manifest.resolve(), args.output.resolve(), args.file, args.browser_receipt)
    print(json.dumps({"sourceCommit": manifest["source"]["commit"], "nativeBinary": manifest["nativeBinary"],
                      "staticDirectory": manifest["staticDirectory"], "hashedArtifacts": len(manifest["artifacts"])}))


if __name__ == "__main__":
    main()
