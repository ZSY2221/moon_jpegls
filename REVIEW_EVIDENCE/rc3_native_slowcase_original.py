from array import array
import fcntl
from hashlib import sha256
import json
from pathlib import Path
from subprocess import PIPE, Popen
from termios import FIONREAD
from time import monotonic, sleep


root = Path.cwd()
build = json.loads((root / "reports/rc2/build.json").read_text())
binary = root / build["nativeBinary"]
fixtures = root / ".evidence/rc2/worker-fixtures"
manifest = json.loads((fixtures / "resource-fixtures.json").read_text())
fixture = manifest["fixtures"][0]
with Popen([binary, "decode", fixtures / fixture["encoded"]["path"], "-", "raw-le", "7"], stdout=PIPE, stderr=PIPE) as process:
    try:
        capacity = fcntl.fcntl(process.stdout.fileno(), fcntl.F_GETPIPE_SZ)
        queued = array("i", [0])
        deadline = monotonic() + 5
        while monotonic() < deadline:
            fcntl.ioctl(process.stdout.fileno(), FIONREAD, queued, True)
            if queued[0] >= capacity - 8 or process.poll() is not None:
                break
            sleep(0.02)
        assert process.poll() is None and queued[0] >= capacity - 8, (queued, capacity)
        sleep(0.1)
        fcntl.ioctl(process.stdout.fileno(), FIONREAD, queued, True)
        assert process.poll() is None
        raw, error = process.communicate(timeout=20)
        assert process.returncode == 0, error
        digest = sha256(raw).hexdigest()
        assert digest == fixture["reconstructedSamples"]["sha256"], digest
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
report = {
    "width": fixture["width"], "height": fixture["height"], "inputChunkBytes": 7,
    "heldAtLeastMsAfterFullPipe": 100, "pipeCapacityBytes": capacity, "queuedBytesWhileHeld": queued[0],
    "runningWhileHeld": True, "finalBytes": len(raw), "reconstructionSha256": digest,
    "nativeBinarySha256": build["artifacts"][build["nativeBinary"]],
}
output = root / "reports/rc2/native-slow-sink.json"
output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps(report))
