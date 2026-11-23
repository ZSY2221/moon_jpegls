"""Prebuilt native CharLS driver. Raw files are uint16 little endian."""

import argparse
import json
from pathlib import Path

import imagecodecs as codecs
import numpy as np


def verify_version():
    if codecs.__version__ != "2026.11.11" or codecs.jpegls_version() != "charls 2.4.5":
        raise RuntimeError("Install scripts/oracle-requirements.txt to use the pinned CharLS wheel")


def read_raw(path):
    return np.frombuffer(path.read_bytes(), dtype="<u2")


def encode_native(samples, bits, near):
    if samples.size == 0 or samples.max() >= 1 << bits:
        raise ValueError("empty input or sample exceeds effective precision")
    if bits not in (8, 16):
        raise ValueError("the native wrapper infers precision from dtype; use the Wasm driver for 12-bit encode")
    return codecs.jpegls_encode(samples.astype(np.uint8 if bits == 8 else np.uint16), level=near)


def decode_native(stream):
    result = codecs.jpegls_decode(stream)
    if result.ndim != 2:
        raise ValueError("expected a monochrome reference frame")
    return result.astype("<u2", copy=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("self-test")
    encode = modes.add_parser("encode")
    decode = modes.add_parser("decode")
    for mode in [encode, decode]:
        mode.add_argument("input", type=Path)
        mode.add_argument("output", type=Path)
    for name in ("width", "height", "near"):
        encode.add_argument(name, type=int)
    encode.add_argument("bits", type=int, choices=[8, 16])
    args = parser.parse_args()
    verify_version()
    if args.mode == "self-test":
        cases = 0
        for bits in (8, 16):
            maximum = (1 << bits) - 1
            values = np.array([[0, maximum // 2, maximum // 2 + 1, maximum]], dtype=np.uint16)
            for near in range(4):
                decoded = decode_native(encode_native(values, bits, near))
                assert np.abs(values.astype(np.int32) - decoded).max() <= near
                cases += 1
        print(json.dumps({"wheel": codecs.__version__, "charls": codecs.jpegls_version(), "selfTestCases": cases}))
    elif args.mode == "encode":
        pixels = read_raw(args.input).reshape((args.height, args.width))
        args.output.write_bytes(encode_native(pixels, args.bits, args.near))
    else:
        pixels = decode_native(args.input.read_bytes())
        args.output.write_bytes(pixels.tobytes())
        print(json.dumps({"width": pixels.shape[1], "height": pixels.shape[0]}))


if __name__ == "__main__":
    main()
