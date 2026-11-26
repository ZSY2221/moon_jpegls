"""Consume a MoonJLS archive outside the repository through loopback or public Mooncakes."""
import argparse
from contextlib import contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import quote, unquote
from urllib.request import Request, urlopen
from zipfile import ZipFile


MODULE = "ZSY2221/moon_jpegls"
REGISTRY = "https://mooncakes.io"
API_PATH = f"/api/v0/registry/modules/{MODULE}"
UNSHIPPED = (".evidence/", ".tools/", "reports/", "submission/", "REVIEW_EVIDENCE/",
             "sdk/generated/", "web/dist/", "_build/", ".mooncakes/")


def digest(data):
    return sha256(data).hexdigest()


def request(url):
    with urlopen(Request(url, headers={"User-Agent": "MoonJLS-release-verify"}), timeout=45) as response:
        return response.status, response.read()


@contextmanager
def candidate_registry(archive, version, paths):
    metadata = json.dumps({"module": MODULE, "version": version, "visibility": "PUBLIC",
                           "deps": {}, "checksum": digest(archive)}).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = unquote(self.path)
            if path in {API_PATH, f"{API_PATH}?version={version}"}:
                code, media, data = 200, "application/json", metadata
            elif path == f"/user/{MODULE}/{version}.zip":
                code, media, data = 200, "application/zip", archive
            else:
                code, media, data = 404, "text/plain", b"not present"
            paths.append({"path": path, "httpStatus": code, "sha256": digest(data)})
            self.send_response(code)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Type", media)
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


def archive_contents(data, version):
    with ZipFile(BytesIO(data)) as archive:
        names = [name.replace("\\", "/") for name in archive.namelist() if not name.endswith("/")]
        assert len(names) == len(set(names))
        assert all(not name.startswith(UNSHIPPED) for name in names)
        required = {"moon.mod", "LICENSE", "THIRD_PARTY_NOTICES", "core/moon.pkg", "core/image.mbt",
                    "core/decoder.mbt", "core/encoder.mbt"}
        assert required.issubset(names)
        manifest = archive.read("moon.mod").decode()
        assert f'name = "{MODULE}"' in manifest
        assert f'version = "{version}"' in manifest
        assert 'license = "BSD-3-Clause"' in manifest
        assert 'import' not in manifest
        signed_paths = required | {name for name in names if name.startswith("core/")}
        return {"bytes": len(data), "sha256": digest(data), "entries": len(names), "manifest": manifest,
                "fileSha256": {name: digest(archive.read(name)) for name in sorted(signed_paths)}}


def run(args, temporary, report):
    win_moon = Path(shutil.which(args.moon) or args.moon).resolve(strict=True)
    app = temporary / "app"
    win_home = temporary / "windows-moon-home"
    for folder in (app, win_home):
        folder.mkdir()
    assert all(not (directory / "moon.work").exists() for directory in [app, *app.parents])
    app_manifest = app / "moon.mod"
    app_manifest.write_text('name = "independent/moonjls_release_probe"\nversion = "0.1.0"\n',
                            newline="\n", encoding="utf-8")
    (app / "moon.pkg").write_text(f'import {{ "{MODULE}/core" @jls }}\npkgtype(kind: "executable")\n',
                                 newline="\n", encoding="utf-8")
    shutil.copyfile(args.consumer, app / "main.mbt")
    assert not (app / ".mooncakes").exists()
    report["consumerSourceSha256"] = digest((app / "main.mbt").read_bytes())
    env = {key: value for key, value in os.environ.items() if not key.startswith(("MOON_", "MOONCAKES"))}
    env.update(MOON_HOME=str(win_home), MOON_TOOLCHAIN_ROOT=str(win_moon.parent.parent),
               MOON_REGISTRY_API="1", MOON_DEP_CACHE="off")
    report["isolation"] = {"freshDirectory": True, "cacheDisabled": True, "onlyPublishedCoordinate": True,
                           "sameFreshInstallForAllThreeTargets": True, "workspaceOverrides": False}
    wsl = ["wsl.exe", "--distribution", args.wsl_distro, "--exec"]

    def redact(value):
        slashed = str(temporary).replace("\\", "/")
        wsl_temp = f"/mnt/{slashed[0].lower()}{slashed[2:]}"
        for path in (str(temporary), slashed, wsl_temp):
            value = value.replace(path, "<isolated>")
        return value

    def command(label, argv, cwd=app):
        completed = subprocess.run([str(item) for item in argv], cwd=cwd, env=env, capture_output=True,
                                   text=True, encoding="utf-8", errors="replace", timeout=150)
        report["commands"].append({"step": label, "command": [redact(str(item)) for item in argv],
                                   "exitCode": completed.returncode, "stdout": redact(completed.stdout),
                                   "stderr": redact(completed.stderr)})
        if completed.returncode != 0:
            raise RuntimeError(f"{label} exited {completed.returncode}: {redact(completed.stderr)}")
        return completed.stdout

    archive = args.archive.read_bytes()
    validated = archive_contents(archive, args.version)
    report["candidateArchive"] = validated
    coordinate = f"{MODULE}@{args.version}"
    if args.mode == "public":
        report["registryMode"] = "public"
        metadata_url = f"{REGISTRY}{API_PATH}?version={quote(args.version)}"
        status, raw = request(metadata_url)
        info = json.loads(raw)
        assert info["module"] == MODULE and info["version"] == args.version and info["visibility"] == "PUBLIC"
        download_url = f"{REGISTRY}/user/{MODULE}/{quote(args.version)}.zip"
        download_status, downloaded = request(download_url)
        official = archive_contents(downloaded, args.version)
        assert info["checksum"] == official["sha256"] == validated["sha256"]
        report["registry"] = {"metadataUrl": metadata_url, "metadataStatus": status, "metadata": info,
                              "downloadUrl": download_url, "downloadStatus": download_status,
                              "archiveSha256": official["sha256"]}
        command("public-moon-add", [win_moon, "add", coordinate])
    else:
        report["registryMode"] = "offline-candidate-loopback"
        paths = report["loopbackRequests"] = []
        with candidate_registry(archive, args.version, paths) as address:
            (win_home / "config.json").write_text(json.dumps({
                "api": address, "download": address, "index": str(win_home / "unused-index"),
            }), encoding="utf-8")
            command("loopback-moon-add", [win_moon, "add", coordinate])
        assert any(p["path"] == f"/user/{MODULE}/{args.version}.zip" and p["sha256"] == validated["sha256"]
                   for p in paths)

    installed = app / ".mooncakes" / MODULE
    assert installed.is_dir() and not installed.is_symlink()
    actual = {name: digest((installed / name).read_bytes()) for name in validated["fileSha256"]}
    assert actual == validated["fileSha256"]
    report["installedSourceMatchesPackage"] = True
    report["consumerManifest"] = app_manifest.read_text(encoding="utf-8")
    assert f'"{coordinate}"' in report["consumerManifest"]
    report["consumerDependencyGraph"] = json.loads(command("graph", [win_moon, "tree", "--json"]))

    results = report["backends"] = {}
    for target in ("js", "wasm-gc"):
        results[target] = command(target, [win_moon, "run", "--release", "--frozen", "--target", target, "."])
    posix_app = command("wsl-path-app", [*wsl, "wslpath", "-a", str(app)]).strip()
    # Native uses the same installed archive and the corresponding freshly populated
    # resolver metadata. A separate empty WSL metadata cache fails --frozen.
    posix_home = command("wsl-path-home", [*wsl, "wslpath", "-a", str(win_home)]).strip()
    assert posix_app.startswith("/mnt/") and posix_home.startswith("/mnt/")
    results["native"] = command(
        "native", ["wsl.exe", "--distribution", args.wsl_distro, "--cd", posix_app, "--exec",
                   "env", "-u", "MOON_WORK", "-u", "MOONCAKES_REGISTRY", "-u", "MOON_REGISTRY_CACHE",
                   f"MOON_HOME={posix_home}", f"MOON_TOOLCHAIN_ROOT={args.wsl_moon.rsplit('/bin/', 1)[0]}",
                   "MOON_REGISTRY_API=1", "MOON_DEP_CACHE=off", args.wsl_moon, "run", "--release",
                   "--frozen", "--target", "native", "."],
    )
    assert results["native"] == results["js"] == results["wasm-gc"]
    assert len(results["native"].splitlines()) == 7


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("offline", "public"))
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--moon", default="moon")
    parser.add_argument("--wsl-distro", default="OpenAtom-Validation-2204-20261120")
    parser.add_argument("--wsl-moon", default="/root/.moon/bin/moon")
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--consumer", default=Path(__file__).with_name("release_consumer.mbt"), type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = {"module": MODULE, "version": args.version, "mode": args.mode, "commands": []}
    try:
        with TemporaryDirectory(prefix="clean-moonjls-external-", ignore_cleanup_errors=True) as path:
            run(args, Path(path).resolve(), report)
        report["verdict"] = "passed"
    except Exception as error:
        report["verdict"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for target, stdout in report["backends"].items():
        print(f"{target} passed")
        print(stdout, end="")


if __name__ == "__main__":
    main()
