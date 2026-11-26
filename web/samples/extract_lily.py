from hashlib import sha256
from pathlib import Path
from subprocess import run
from tempfile import TemporaryDirectory
import argparse

from PIL import Image
import numpy as np


def main():
    parser = argparse.ArgumentParser(description="Build pinned microscopy workbench samples.")
    parser.add_argument("source", type=Path)
    options = parser.parse_args()
    expected_sha256 = "395c2f0194c25b9824a8cd79266920362a0816bc9e906dd392adce2d8309af03"
    if sha256(options.source.read_bytes()).hexdigest() != expected_sha256:
        parser.error("source TIFF hash does not match the pinned scikit-image dataset")

    output = Path(__file__).resolve().parent
    repo = output.parents[1]
    width, height = 144, 111
    x, y = 395, 344
    channels = []
    with Image.open(options.source) as image:
        for index in range(3):
            image.seek(index)
            crop = image.crop((x, y, x + width, y + height))
            channels.append(np.asarray(crop, dtype=np.uint16))
    samples = np.stack(channels, axis=-1)

    scaled = ((samples.astype(np.uint32) * 255 + 2047) // 4095).astype(np.uint8)
    (output / "lily-8.ppm").write_bytes(
        f"P6\n{width} {height}\n255\n".encode() + scaled.tobytes()
    )
    (output / "lily-16.ppm").write_bytes(
        f"P6\n{width} {height}\n65535\n".encode() + samples.astype(">u2").tobytes()
    )

    with TemporaryDirectory() as temporary:
        raw = Path(temporary, "planes.raw")
        encoded = Path(temporary, "lily-sampled.jls")
        planes = (scaled[:, :, 0], scaled[::4, :, 1], scaled[::2, ::2, 2])
        group = (4, 1, 2)
        with raw.open("wb") as output_file:
            for mcu in range((height + 3) // 4):
                for plane, rows in zip(planes, group):
                    start = mcu * rows
                    output_file.write(plane[start:start + rows].astype("<u2").tobytes())
        run(
            [
                "node", "sdk/cli.mjs", "encode", "--backend", "js",
                "--input", str(raw), "--output", str(encoded),
                "--width", str(width), "--height", str(height), "--bits", "8",
                "--components", "3", "--ilv", "1", "--sampling", "2x4,2x1,1x2",
            ],
            cwd=repo, check=True,
        )
        (output / encoded.name).write_bytes(encoded.read_bytes())


if __name__ == "__main__":
    main()
