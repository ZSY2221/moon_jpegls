# Independent MoonBit consumer

Run from the MoonJLS checkout root with the current MoonBit toolchain.

```sh
moon -C examples/consumer update
moon -C examples/consumer run . --target wasm-gc
moon -C examples/consumer run . --target js
```

This module declares `ZSY2221/moon_jpegls@0.1.0` as a normal MoonBit dependency. The local `moon.work` resolves it from the checkout for pre-release testing. The first example encodes and reconstructs six 12-bit integer samples using only the public core API. The second encodes a strided 16-bit grayscale `Image` from `moonbitstack/moonimage@0.2.1` and verifies the reconstructed bytes, including samples on both sides of 32768.

Both checks also ran with `moon -C examples/consumer --target-dir ../../.evidence/native-consumer run . --target native` on Ubuntu 22.04.2 in WSL2 with GCC 11.4.0. All three backends reported 48 and 60 encoded bytes for the two examples.

The `gray16` package reads the raster's big-endian bytes using its stride, preserving integer values and ignoring row padding. Pass the JPEG-LS effective precision explicitly. A Gray16 container can carry samples with 12-bit precision. The decoder returns the reconstructed Gray16 image along with the JPEG-LS `Frame`, which retains its effective precision and NEAR. The returned image contains a tight big-endian raster and fresh default MoonImage metadata.

This convenience adapter holds complete rasters and allocates a full sample array. For bounded memory, use the public streaming encoder and decoder with a row source and sink. [MoonImage raster API](https://github.com/moonbitstack/moonimage/blob/4f34b3d2680bdc144a9b082386fe02c9484a158f/src/raster/pkg.generated.mbti#L134-L160)
