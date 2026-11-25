"""Verify isolated consumption of one MoonJLS git revision and Moon package."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import unquote
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[2]
MODULE = "ZSY2221/moon_jpegls"
VERSION = "0.1.0"
PIN = "9667375c42dd5d20aba832c1c07ebcd0fdfad214"
METADATA = "/api/v0/registry/modules/"
OFFICIAL = "https://mooncakes.io"
CASES = [
    (12, [0, 1, 2047, 2048, 4094, 4095]),
    (16, [0, 1, 32767, 32768, 65534, 65535]),
]
M2_CASES = [
    (12, [0, 1, 2047, 2048, 4092, 4093]),
    (16, [0, 1, 32767, 32768, 49999, 50000]),
]
CONSUMER = r'''fn main {
  let cases : Array[(Int32, FixedArray[Int32])] = [
    (12, [0, 1, 2047, 2048, 4094, 4095]),
    (16, [0, 1, 32767, 32768, 65534, 65535]),
  ]
  for entry in cases {
    let (bits, original) = entry
    for near in [0, 255] {
      let frame : @jls.Frame = { width: 3, height: 2, bits, near }
      let coded = @jls.encode(frame, original)
      let (reconstructed_frame, samples) = @jls.decode(coded)
      assert_eq(reconstructed_frame, frame)
      assert_eq(frame.maxval(), (1 << bits) - 1)
      assert_eq(samples.length(), original.length())
      let mut maximum = 0
      for i in 0..<samples.length() {
        let error = (samples[i] - original[i]).abs()
        assert_true(error <= near)
        if error > maximum { maximum = error }
        println("sample bits=\{bits} near=\{near} index=\{i} original=\{original[i]} reconstructed=\{samples[i]}")
      }
      let decoder = @jls.Decoder::new(@jls.Limits::default())
      let mut offset = 0
      let mut rows = 0
      while true {
        let step = decoder.step(coded, offset, coded.length() - offset, true)
        offset += step.consumed
        match step.status {
          RowReady => {
            assert_eq(decoder.frame(), Some(frame))
            let row = decoder.row()
            assert_eq(row.length(), frame.width)
            for x in 0..<row.length() {
              assert_eq(row[x], samples[rows * frame.width + x])
            }
            rows += 1
          }
          Done => break
          _ => abort("unexpected consumer decoder status")
        }
      }
      assert_eq(offset, coded.length())
      assert_eq(rows, frame.height)
      println("case bits=\{bits} near=\{near} rows=\{rows} bytes=\{coded.length()} maxError=\{maximum}")
    }
  }
}
'''


def digest(content):
    return sha256(content).hexdigest()


def record_http(path):
    url = OFFICIAL + METADATA + path
    command = ["curl", "--silent", "--show-error", "--max-time", "12", "--write-out", "\n%{http_code}", url]
    result = subprocess.run(command, capture_output=True, text=True, timeout=15)
    if result.returncode:
        return {"url": url, "command": command, "error": result.stderr}
    body, _, status = result.stdout.rpartition("\n")
    try:
        body = json.loads(body)
    except ValueError:
        pass
    return {"url": url, "command": command, "status": int(status), "body": body}


@contextmanager
def loopback_registry(package, requests):
    metadata = json.dumps({
        "module": MODULE, "version": VERSION, "visibility": "PUBLIC", "deps": {},
        "checksum": digest(package),
    }).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = unquote(self.path)
            if path in (METADATA + MODULE, METADATA + MODULE + "?version=" + VERSION):
                status, content_type, body = 200, "application/json", metadata
            elif path == f"/user/{MODULE}/{VERSION}.zip":
                status, content_type, body = 200, "application/zip", package
            else:
                status, content_type, body = 404, "text/plain", b"not present in local registry"
            requests.append({"path": path, "status": status, "bytes": len(body), "sha256": digest(body)})
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


def trials(stdout, expected=CASES):
    results = {}
    for line in stdout.splitlines():
        kind, _, fields = line.partition(" ")
        if kind not in ("case", "sample"):
            continue
        values = {key: int(value) for key, value in (field.split("=") for field in fields.split())}
        case = results.setdefault((values["bits"], values["near"]), {"samples": []})
        if kind == "sample":
            case["samples"].append(values)
        else:
            case.update(values)
    assert set(results) == {(bits, near) for bits, _ in expected for near in (0, 255)}
    for bits, original in expected:
        for near in (0, 255):
            case = results[bits, near]
            assert case["rows"] == 2
            assert [sample["index"] for sample in case["samples"]] == list(range(len(original)))
            assert [sample["original"] for sample in case["samples"]] == original
            errors = [abs(sample["original"] - sample["reconstructed"]) for sample in case["samples"]]
            assert max(errors) == case["maxError"] <= near
    return list(results.values())


def verify(args, work, report):
    moon = Path(shutil.which(args.moon) or args.moon).resolve(strict=True)
    toolchain = moon.parent.parent
    public_home = work / "public-moon-home"
    local_home = work / "local-moon-home"
    for home in (public_home, local_home):
        home.mkdir()
    base = dict(os.environ, MOON_TOOLCHAIN_ROOT=str(toolchain), MOON_REGISTRY_API="1", MOON_DEP_CACHE="off")
    for key in ("MOON_WORK", "MOONCAKES_REGISTRY", "MOON_REGISTRY_CACHE"):
        base.pop(key, None)

    def redact(value):
        for path, stand_in in ((work, "<temp>"), (ROOT, "<repo>"), (toolchain, "<moon-toolchain>")):
            for spelling in {str(path), path.as_posix()}:
                value = value.replace(spelling, stand_in).replace(spelling.replace("\\", "\\\\"), stand_in)
        return value

    def run(step, command, cwd, env=base, require_success=True):
        process = subprocess.run(command, cwd=cwd, env=env, capture_output=True, timeout=120, text=True, errors="replace")
        log = {"step": step, "cwd": redact(str(cwd)), "command": [redact(str(item)) for item in command],
               "exitCode": process.returncode, "stdout": redact(process.stdout), "stderr": redact(process.stderr)}
        report["commands"].append(log)
        if require_success and process.returncode:
            raise RuntimeError(f"{step} exited {process.returncode}: {log['stderr']}")
        return process

    run("moon-version", [moon, "version", "--all"], work)
    run("compiler-version", [*shlex.split(base.get("CC", "cc")), "--version"], work)
    run("node-version", ["node", "--version"], work)
    report["registryHttp"] = [record_http(path) for path in (
        MODULE + "?version=" + VERSION, MODULE, "moonbitstack/moonimage?version=0.2.1",
    )]
    public = work / "public-probe"
    public.mkdir()
    (public / "moon.mod").write_text('name = "independent/registry_probe"\n', encoding="utf-8")
    public_env = dict(base, MOON_HOME=str(public_home))
    report["publicInstallSucceeded"] = False
    for coord in (f"{MODULE}@{VERSION}", MODULE):
        result = run("public-moon-add", [moon, "add", coord], public, public_env, require_success=False)
        report["publicInstallSucceeded"] |= result.returncode == 0

    git_root = args.git_root.resolve() if args.git_root else ROOT
    commit = run("resolve-source", ["git", "-C", git_root, "rev-parse", args.commit + "^{commit}"], work).stdout.strip()
    report["sourceCommit"] = commit
    with TemporaryDirectory(prefix="pack-", dir=work) as building:
        source = Path(building)
        snapshot = work / "snapshot.zip"
        run("archive-source", ["git", "-C", git_root, "archive", "--format=zip", f"--output={snapshot}", commit], work)
        with ZipFile(snapshot) as archive:
            archive.extractall(source)
        snapshot.unlink()
        assert not (source / "moon.work").exists()
        run("moon-package", [moon, "package", "--frozen"], source, public_env)
        archives = list((source / "_build" / "publish").glob("*.zip"))
        assert len(archives) == 1
        package = archives[0].read_bytes()
        with ZipFile(archives[0]) as archive:
            files = archive.namelist()
            manifest = archive.read("moon.mod")
            assert manifest == (source / "moon.mod").read_bytes()
            included = {name: digest(archive.read(name)) for name in files if name.startswith("core/") and not name.endswith("/")}
            assert "core/moon.pkg" in included
        report["archive"] = {"filename": archives[0].name, "bytes": len(package), "sha256": digest(package),
                             "entries": len(files), "coreFilesSha256": included}
    assert not source.exists() and not snapshot.exists()
    if args.archive:
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        args.archive.write_bytes(package)

    app = work / "independent-consumer"
    app.mkdir()
    (app / "moon.mod").write_text('name = "independent/moonjls_probe"\nversion = "0.1.0"\n', encoding="utf-8")
    (app / "moon.pkg").write_text(f'import {{ "{MODULE}/core" @jls }}\npkgtype(kind: "executable")\n', encoding="utf-8")
    consumer = (ROOT / "tests/conformance/consumer_m2.mbt").read_text(encoding="utf-8") if args.m2 else CONSUMER
    (app / "main.mbt").write_text(consumer, encoding="utf-8")
    assert all(not (directory / "moon.work").exists() for directory in [app, *app.parents])
    assert not (app / ".mooncakes").exists()
    requests = []
    report["localRegistryRequests"] = requests
    local_env = dict(base, MOON_HOME=str(local_home))
    with loopback_registry(package, requests) as address:
        (local_home / "config.json").write_text(json.dumps({
            "api": address, "download": address, "index": str(local_home / "unused-index"),
        }), encoding="utf-8")
        run("loopback-moon-add", [moon, "add", f"{MODULE}@{VERSION}"], app, local_env)
    assert any(job["path"] == f"/user/{MODULE}/{VERSION}.zip" and job["sha256"] == digest(package) for job in requests)
    installed = app / ".mooncakes" / MODULE
    assert all(digest((installed / name).read_bytes()) == expected for name, expected in included.items())
    report["installedCoreMatchesArchive"] = True
    report["consumerManifest"] = (app / "moon.mod").read_text(encoding="utf-8")
    assert f'"{MODULE}@{VERSION}"' in report["consumerManifest"]
    graph = run("resolved-module-graph", [moon, "tree", "--json"], app, local_env)
    report["consumerDependencyGraph"] = json.loads(redact(graph.stdout))
    report["isolation"] = {
        "outsideRepository": ROOT not in app.parents, "moonWorkUsed": False,
        "exportedSourceRemovedBeforeConsumerCreated": True, "sharedDependencyCache": False,
        "registryStoppedBeforeBackendRuns": True,
    }
    outcomes = {}
    for backend in ("js", "wasm-gc", "native"):
        result = run(f"consume-{backend}", [moon, "run", "--release", "--frozen", "--target", backend, "."],
                     app, local_env)
        outcomes[backend] = trials(result.stdout, M2_CASES if args.m2 else CASES)
    assert outcomes["js"] == outcomes["wasm-gc"] == outcomes["native"]
    report["backends"] = outcomes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", default=PIN)
    parser.add_argument("--moon", default="moon")
    parser.add_argument("--git-root", type=Path, help="Repository holding the commit when the worktree .git uses host-specific paths")
    parser.add_argument("--m2", action="store_true", help="Exercise non-default MAXVAL and active LSE metadata")
    parser.add_argument("--archive", type=Path, help="Retain the Moon archive at this path")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("result.json"))
    args = parser.parse_args()
    if args.m2 and args.commit == PIN:
        parser.error("--m2 requires an explicit commit implementing the Preset API")
    report = {"m2": args.m2, "recordedAtSingapore": datetime.now(timezone(timedelta(hours=8))).isoformat(), "commands": []}
    try:
        with TemporaryDirectory(prefix="moonjls-consumer-") as root:
            work = Path(root).resolve()
            assert ROOT != work and ROOT not in work.parents
            verify(args, work, report)
        report["verdict"] = "passed"
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
