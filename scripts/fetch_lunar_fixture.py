#!/usr/bin/env python3
"""Fetch the fixed NASA LOLA grayscale fixture and preserve its integer samples."""

import argparse
from array import array
import hashlib
from pathlib import Path
import sys
from urllib.request import Request, urlopen


SOURCE = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4_uint.tif"
SOURCE_SIZE = 2_076_866
SOURCE_SHA256 = "e6668bec27fc9b8fbb02d198c7ddfb08eedeeb790167b494f95e6b34201da05e"
PGM_SHA256 = "1adb4e047099b942c229a8d21d33b6227dd2b6af22984d8d9de6b128b0e858a6"
WIDTH = 1440
HEIGHT = 720


def download():
    data = bytearray()
    for _ in range(10):
        # A partial response may still supply the prefix of its requested range.
        offset = len(data)
        headers = {"Range": f"bytes={offset}-{SOURCE_SIZE - 1}"} if offset else {}
        with urlopen(Request(SOURCE, headers=headers), timeout=30) as response:
            if response.status == 200:
                data.clear()
            elif response.headers.get("Content-Range") != (
                f"bytes {offset}-{SOURCE_SIZE - 1}/{SOURCE_SIZE}"
            ):
                raise ValueError("NASA TIFF returned an unexpected range")
            data.extend(response.read(SOURCE_SIZE - len(data)))
        if len(data) == SOURCE_SIZE:
            return data
    raise ValueError("NASA TIFF transfer ended before the expected length")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="destination binary PGM")
    parser.add_argument("--source-tiff", type=Path, help="convert a local copy of the pinned NASA TIFF")
    args = parser.parse_args()

    try:
        if args.source_tiff is None:
            data = download()
        else:
            with args.source_tiff.open("rb") as source:
                data = source.read(SOURCE_SIZE + 1)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Could not read NASA TIFF: {error}\n")
    if len(data) != SOURCE_SIZE or hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        parser.exit(1, "NASA TIFF differs from the recorded snapshot\n")

    # The verified TIFF stores 360 consecutive 5760-byte little-endian
    # grayscale strips immediately after its eight-byte file header.
    samples = array("H")
    samples.frombytes(data[8:8 + 2 * WIDTH * HEIGHT])
    if sys.byteorder == "little":
        samples.byteswap()
    pgm = f"P5\n{WIDTH} {HEIGHT}\n65535\n".encode("ascii") + samples.tobytes()
    if hashlib.sha256(pgm).hexdigest() != PGM_SHA256:
        parser.exit(1, "Generated PGM differs from the recorded fixture\n")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(pgm)
    print(f"{args.output} {WIDTH}x{HEIGHT} uint16be PGM sha256={PGM_SHA256}")


if __name__ == "__main__":
    main()
