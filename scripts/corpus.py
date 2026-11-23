"""Deterministic image fixtures and pinned downloads for offline validation."""

from hashlib import sha256
from pathlib import Path
import re
import urllib.request

import numpy as np


ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / ".evidence"
TOOLS = ROOT / ".tools"
SEED = 0x87_16_123
CHARLS = "14b654dff1efed4d04e278ff3e99f0a486cf20cc"
CONFORMANCE = f"https://raw.githubusercontent.com/team-charls/charls/{CHARLS}/test/conformance/"
CONFORMANCE_HASHES = {
    "test16.pgm": "1eb2001a0fe66c9d44776b40a35aaa3b68a4fe74cb749e6271d96523378149d2",
    "t16e0.jls": "0169aab6eb839925cc781016e3c3ed19d323fadee99d9747375e787b88e4d23f",
    "t16e3.jls": "e3b7327d232247949bd6aa4520d3a2627bb60c952ff23d700c92900a70863813",
    "t8c0e0.jls": "8c564fbd3a8667bd071cc8d994952fdfae3d62db5c359be4b6d6734e89acea6d",
    "t8c1e0.jls": "fdd6fa22f94135f7c3db7932da2154aefc79085fec3b3f65da8a62d6964b8078",
    "t8c2e0.jls": "2cbf1d38b9d186a06ea7b19cc74df6259d238c789f49ed7329a8e34afd6ba5ae",
    "t8nde0.jls": "c3e1244dfc035626cbdea7a89a8120fde3ae4deb22847695928cfbd5f36884ae",
    "t8sse0.jls": "bee806d92fb11dcdaf4ad1dbcc695622f95fdd4d8a7d6d77f72fc1a0d98f6d26",
}
LILY_URL = "https://gitlab.com/scikit-image/data/-/raw/2cdc5ce89b334d28f06a58c9f0ca21aa6992a5ba/lily-of-the-valley-fluorescence.tif"
LILY_SHA256 = "395c2f0194c25b9824a8cd79266920362a0816bc9e906dd392adce2d8309af03"


def save_raw(path, pixels):
    path.write_bytes(pixels.astype("<u2", copy=False).tobytes())


def pgm_samples(path):
    data = path.read_bytes()
    header = re.match(rb"P5\s+(?:\#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)(?:\r\n|\s)", data)
    if header is None:
        raise ValueError(f"invalid P5 header: {path}")
    width, height, maximum = map(int, header.groups())
    shape = (height, width)
    return np.frombuffer(data[header.end():], dtype="u1" if maximum < 256 else ">u2").reshape(shape), maximum


def fixtures(bits):
    maximum = (1 << bits) - 1
    border = np.array([0, 1, 2, 3, maximum // 2, maximum // 2 + 1, maximum - 3, maximum - 1, maximum], dtype=np.uint16)
    yield "pixel", np.array([[maximum]], dtype=np.uint16)
    yield "row", np.resize(border, (1, 129))
    yield "column", np.resize(border, (131, 1))
    yield "stuffing-runs", np.zeros((17, 513), dtype=np.uint16)
    yield "constant-high", np.full((33, 53), maximum, dtype=np.uint16)
    yy, xx = np.indices((41, 73))
    yield "checker", ((yy + xx) % 2 * maximum).astype(np.uint16)
    yy, xx = np.indices((31, 127))
    yield "mixed-run-boundary", np.where(yy % 2, (xx * (maximum // 126)), (xx // 21) % 2 * maximum).astype(np.uint16)
    rng = np.random.Generator(np.random.PCG64(SEED + bits))
    noise = rng.integers(0, maximum + 1, (63, 97), dtype=np.uint16)
    noise.flat[:len(border)] = border
    yield "noise", noise
    if bits == 16:
        yield "all-values", np.arange(65536, dtype=np.uint16).reshape((256, 256))


def benchmark_fixtures():
    yy, xx = np.indices((512, 768))
    maximum = 65535
    rng = np.random.Generator(np.random.PCG64(SEED))
    yield "smooth", (17 * xx + 71 * yy).astype(np.uint16), 16, "synthetic"
    yield "edges", np.where((xx // 19 + yy // 23) % 2, maximum, 0).astype(np.uint16), 16, "synthetic"
    texture = np.sin(xx * 0.08 + np.sin(yy * 0.09) * 2) * 9000 + np.sin(yy * 0.14) * 7000
    yield "texture", (32768 + texture + rng.integers(-40, 41, texture.shape)).astype(np.uint16), 16, "synthetic"
    yield "noise", rng.integers(0, 65536, yy.shape, dtype=np.uint16), 16, "synthetic"


def download(path, url, limit, digest=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size <= limit:
        existing = path.read_bytes()
        if digest is None or sha256(existing).hexdigest() == digest:
            return existing
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit or digest is not None and sha256(data).hexdigest() != digest:
        raise ValueError(f"Unexpected source size or digest: {url}")
    path.write_bytes(data)
    return data
