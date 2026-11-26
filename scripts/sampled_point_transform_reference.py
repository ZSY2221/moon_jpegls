"""Short-vector reference for T.87 Annexes A, B, C, and F.

Uses scalar integers, tuple-keyed contexts, and whole rows for auditable test
vectors. This is a verifier for the unmapped interchange profile, with marker
and geometry checks limited to the fixtures it exchanges. No MoonJLS code,
outputs, or bindings are used by this reference.
"""

from dataclasses import dataclass
from itertools import chain
import json
import sys


# T.87 A.2.1
J = (0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
     4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15)


def word(number):
    return number.to_bytes(2, "big")


def segment(code, payload):
    return bytes((255, code)) + word(len(payload) + 2) + bytes(payload)


def parts(data):
    """Yield marker segments and the bounded entropy data that follows each SOS."""
    assert data[:2] == b"\xff\xd8"
    off = 2
    while off < len(data):
        assert data[off] == 255
        code = data[off + 1]
        off += 2
        if code == 217:
            assert off == len(data), "trailing bytes"
            return
        size = int.from_bytes(data[off:off + 2], "big")
        assert 2 <= size <= len(data) - off
        payload = data[off + 2:off + size]
        off += size
        if code == 218:
            start = off
            while off < len(data) - 1:
                if data[off] != 255:
                    off += 1
                elif data[off + 1] < 128:
                    off += 2
                else:
                    break
            yield code, payload, data[start:off]
        else:
            yield code, payload, None
    raise AssertionError("missing EOI")


class Writer:
    def __init__(self):
        self.bits = []

    def put(self, n, size):
        self.bits.extend((n >> i) & 1 for i in range(size - 1, -1, -1))

    def finish(self):
        output = bytearray()
        offset = 0
        capacity = 8
        while offset < len(self.bits):
            value = 0
            for j in range(capacity):
                value <<= 1
                if offset < len(self.bits):
                    value |= self.bits[offset]
                    offset += 1
            output.append(value)
            capacity = 7 if value == 255 else 8
        if capacity == 7:
            output.append(0)
        return bytes(output)


class Reader:
    def __init__(self, data):
        self.bits = []
        self.offset = 0
        capacity = 8
        for value in data:
            assert capacity == 8 or value < 128, "invalid stuffed bit"
            self.bits.extend((value >> i) & 1 for i in range(capacity - 1, -1, -1))
            capacity = 7 if value == 255 else 8
        assert capacity == 8, "missing stuffed bit after FF"

    def get(self, size):
        assert self.offset + size <= len(self.bits), "truncated entropy"
        value = 0
        for _ in range(size):
            value = (value << 1) | self.bits[self.offset]
            self.offset += 1
        return value

    def finish(self):
        remaining = self.bits[self.offset:]
        assert len(remaining) <= 7 and not any(remaining), "excess entropy or nonzero final fill"


@dataclass
class Stats:
    a: int
    n: int = 1
    bias: int = 0
    correction: int = 0
    negatives: int = 0


@dataclass
class Run:
    index: int = 0

    def exchange(self, entropy, left, count):
        """A.7.1: exchange a run length, retaining the pre-decrement limit."""
        if isinstance(entropy, Writer):
            remain = count
            while remain >= 1 << J[self.index]:
                entropy.put(1, 1)
                remain -= 1 << J[self.index]
                self.index = min(31, self.index + 1)
            exponent = J[self.index]
            if count < left:
                entropy.put(0, 1)
                entropy.put(remain, exponent)
                self.index = max(0, self.index - 1)
            elif remain:
                entropy.put(1, 1)
            return count, exponent

        count = 0
        while count < left:
            exponent = J[self.index]
            segment_length = 1 << exponent
            if entropy.get(1):
                actual = min(left - count, segment_length)
                count += actual
                if actual == segment_length:
                    self.index = min(31, self.index + 1)
            else:
                count += entropy.get(exponent)
                assert count < left, "run count outside line"
                self.index = max(0, self.index - 1)
                return count, exponent
        return count, J[self.index]


@dataclass
class Component:
    upper: list
    run: Run
    corner: int = 0

    def neighbours(self, row, x):
        rb = self.upper[x]
        return (
            row[x - 1] if x else rb,
            rb,
            self.upper[x - 1] if x else self.corner,
            self.upper[min(x + 1, len(self.upper) - 1)],
        )

    def advance(self, row):
        self.corner = self.upper[0]
        self.upper = row


def thresholds(maxval, near):
    """C.2.4.1.1.1"""
    if maxval >= 128:
        factor = (min(4095, maxval) + 128) // 256
        targets = (factor + 2 + 3 * near, 4 * factor + 3 + 5 * near, 17 * factor + 4 + 7 * near)
    else:
        factor = 256 // (maxval + 1)
        targets = tuple(max(limit, initial // factor + scale * near)
                     for limit, initial, scale in zip((2, 3, 4), (3, 7, 21), (3, 5, 7)))

    result = []
    low = near + 1
    for target in targets:
        low = target if low <= target <= maxval else low
        result.append(low)
    return result


class AnnexA:
    def __init__(self, bits, near, lse):
        self.maxval = lse[0] or (1 << bits) - 1  # P is the SOF precision, not P-Pt.
        self.near = near
        self.reset = lse[4] or 64
        self.quantums = tuple(value or default for value, default
                              in zip(lse[1:4], thresholds(self.maxval, near)))
        self.step = 2 * near + 1
        self.range = (self.maxval + 2 * near) // self.step + 1
        self.qbpp = (self.range - 1).bit_length()
        bpp = max(2, self.maxval.bit_length())
        self.limit = 2 * (bpp + max(8, bpp))
        self.initial = max(2, (self.range + 32) // 64)
        self.contexts = {}
        self.interruptions = (Stats(self.initial), Stats(self.initial))

    def context(self, neighbours):
        ra, rb, rc, rd = neighbours
        gradients = (rd - rb, rb - rc, rc - ra)
        quantized = []
        for g in gradients:
            magnitude = abs(g)
            level = 0 if magnitude <= self.near else 1 + sum(magnitude >= t for t in self.quantums)
            quantized.append(level if g >= 0 else -level)
        sign = -1 if next((q for q in quantized if q), 0) < 0 else 1
        return tuple(sign * q for q in quantized), sign

    def limit_error(self, delta):
        low = -(self.range // 2)
        quantized = (abs(delta) + self.near) // self.step
        if delta < 0:
            quantized = -quantized
        return (quantized - low) % self.range + low

    def recover(self, prediction, error, sign):
        """Annex F, Step 14."""
        x = prediction + sign * error * self.step
        if x < -self.near:
            x += self.range * self.step
        elif x > self.maxval + self.near:
            x -= self.range * self.step
        return max(0, min(self.maxval, x))

    def golomb(self, entropy, k, limit, mapped=None):
        """A.5.3: limited unary prefix and fixed-width escaped remainder."""
        escape = limit - self.qbpp - 1
        if isinstance(entropy, Writer):
            prefix = mapped >> k
            count = min(prefix, escape)
            entropy.put(0, count)
            entropy.put(1, 1)
            if prefix < escape:
                entropy.put(mapped & ((1 << k) - 1), k)
            else:
                entropy.put(mapped - 1, self.qbpp)
            return mapped
        count = 0
        while not entropy.get(1):
            count += 1
            assert count <= escape, "overlong unary word"
        return (count << k) + entropy.get(k) if count < escape else entropy.get(self.qbpp) + 1

    @staticmethod
    def order(n, a):
        k = 0
        while n << k < a:
            k += 1
        return k

    def regular(self, entropy, neighbours, context, sign, sample=None):
        """A.4–A.6: predictor, reversible mapping, then bias update."""
        stats = self.contexts.setdefault(context, Stats(self.initial))
        ra, rb, rc, _ = neighbours
        median = sorted((ra, rb, ra + rb - rc))[1]
        prediction = max(0, min(self.maxval, median + sign * stats.correction))
        k = self.order(stats.n, stats.a)
        invert = self.near == 0 and k == 0 and 2 * stats.bias <= -stats.n
        if sample is None:
            code = self.golomb(entropy, k, self.limit) ^ invert
            error = -(code + 1) // 2 if code & 1 else code // 2
        else:
            error = self.limit_error((sample - prediction) * sign)
            code = 2 * error if error >= 0 else -2 * error - 1
            self.golomb(entropy, k, self.limit, code ^ invert)

        stats.a += abs(error)
        stats.bias += error * self.step
        if stats.n == self.reset:
            stats.a //= 2
            stats.bias //= 2
            stats.n //= 2
        stats.n += 1
        if stats.bias <= -stats.n:
            stats.bias = max(-stats.n + 1, stats.bias + stats.n)
            stats.correction = max(-128, stats.correction - 1)
        elif stats.bias > 0:
            stats.bias = min(0, stats.bias - stats.n)
            stats.correction = min(127, stats.correction + 1)
        return self.recover(prediction, error, sign)

    def interrupt(self, entropy, neighbours, exponent, joint, sample=None):
        """A.7.2 and B.3: RItype, mapped sign, and context update."""
        ra, rb, _, _ = neighbours
        kind = int(not joint and abs(ra - rb) <= self.near)
        prediction = ra if kind else rb
        sign = -1 if not kind and ra > rb else 1
        stats = self.interruptions[kind]
        k = self.order(stats.n, stats.a + kind * (stats.n // 2))
        prefer_positive = k == 0 and 2 * stats.negatives < stats.n
        limit = self.limit - exponent - 1
        if sample is None:
            code = self.golomb(entropy, k, limit)
            absolute = (code + kind + 1) // 2
            negative = bool((code + kind) & 1) != prefer_positive
            error = -absolute if negative else absolute
        else:
            error = self.limit_error((sample - prediction) * sign)
            mapped_sign = error > 0 if prefer_positive else error < 0
            code = 2 * abs(error) - kind - mapped_sign
            assert code >= 0
            self.golomb(entropy, k, limit, code)
        if error < 0:
            stats.negatives += 1
        stats.a += (code + 1 - kind) // 2
        if stats.n == self.reset:
            stats.a //= 2
            stats.n //= 2
            stats.negatives //= 2
        stats.n += 1
        return self.recover(prediction, error, sign)

    def lines(self, entropy, components, run, originals=None):
        """A.8 for a line or B.3 for parallel equal-width sample vectors."""
        width = len(components[0].upper)
        rows = [[] for _ in components]
        encoding = originals is not None
        x = 0
        while x < width:
            neighbours = [component.neighbours(row, x) for component, row in zip(components, rows)]
            contexts = [self.context(template) for template in neighbours]
            if any(key != (0, 0, 0) for key, _ in contexts):
                for i, (row, template, (key, sign)) in enumerate(zip(rows, neighbours, contexts)):
                    row.append(self.regular(entropy, template, key, sign, originals[i][x] if encoding else None))
                x += 1
                continue

            count = None
            ra = [neighbour[0] for neighbour in neighbours]
            if encoding:
                count = 0
                while x + count < width and all(abs(row[x + count] - a) <= self.near for row, a in zip(originals, ra)):
                    count += 1
            count, exponent = run.exchange(entropy, width - x, count)
            for row, value in zip(rows, ra):
                row.extend([value] * count)
            x += count
            if x < width:
                for i, (component, row) in enumerate(zip(components, rows)):
                    template = component.neighbours(row, x)
                    row.append(self.interrupt(entropy, template, exponent, len(rows) > 1,
                                              originals[i][x] if encoding else None))
                x += 1

        for component, row in zip(components, rows):
            component.advance(row)
        return rows


def ceil_div(a, b):
    return (a + b - 1) // b


def geometry(frame):
    components = frame["components"]
    maxh = max(comp["hSampling"] for comp in components)
    maxv = max(comp["vSampling"] for comp in components)
    return [(ceil_div(frame["width"] * comp["hSampling"], maxh),
             ceil_div(frame["height"] * comp["vSampling"], maxv)) for comp in components]


def line_groups(frame, scan, sizes):
    """B.4: lines for ILV 0 and 1, parallel component vectors for ILV 2."""
    members = [next(i for i, c in enumerate(frame["components"]) if c["id"] == cid) for cid in scan["ids"]]
    mode = scan["ilv"]
    if mode == 0:
        assert len(members) == 1
        cid = members[0]
        for line in range(sizes[cid][1]):
            yield [(cid, line)]
    elif mode == 1:
        assert len(members) > 1
        mcus = ceil_div(frame["height"], max(comp["vSampling"] for comp in frame["components"]))
        for mcu in range(mcus):
            for cid in members:
                vertical = frame["components"][cid]["vSampling"]
                for line in range(mcu * vertical, (mcu + 1) * vertical):
                    yield [(cid, line)]
    else:
        assert mode == 2 and len(members) > 1
        assert len({sizes[cid] for cid in members}) == 1
        for line in range(sizes[members[0]][1]):
            yield [(cid, line) for cid in members]


def scan_image(frame, scan, entropy, destination, source=None, pad_mode="copy"):
    sizes = geometry(frame)
    states = [Component([0] * width, Run()) for width, _ in sizes]
    joint_run = Run()
    model = AnnexA(frame["bits"], scan["near"], scan["lse"])
    padded = 0
    pt = scan["pt"]
    for group in line_groups(frame, scan, sizes):
        originals = None
        if source is not None:
            originals = []
            for cid, line in group:
                width, height = sizes[cid]
                if line < height:
                    rowsamples = source[cid][line * width:(line + 1) * width]
                    originals.append([sample >> pt for sample in rowsamples])
                elif pad_mode == "distinct":
                    # B.4 leaves the values of added lines unspecified. Very
                    # different coded values expose omitted entropy consumption.
                    originals.append([((line * 19 + x * 7 + cid * 13) % 35) for x in range(width)])
                else:
                    originals.append(states[cid].upper)
        run = joint_run if scan["ilv"] == 2 else states[group[0][0]].run
        decoded = model.lines(entropy, [states[cid] for cid, _ in group], run, originals)
        for (cid, line), values in zip(group, decoded):
            if line < sizes[cid][1]:
                destination[cid].extend(q << pt for q in values)
            else:
                padded += 1
    return padded


def build(frame, scans, samples, pad_mode="copy"):
    sof = bytes((frame["bits"],)) + word(frame["height"]) + word(frame["width"])
    sof += bytes((len(frame["components"]),))
    sof += bytes(chain.from_iterable((c["id"], c["hSampling"] * 16 + c["vSampling"], 0)
                                     for c in frame["components"]))
    stream = bytearray(b"\xff\xd8" + segment(247, sof))
    decoded = [[] for _ in frame["components"]]
    padding = []
    lse = (0, 0, 0, 0, 0)
    for requested in scans:
        preset = tuple(requested.get("lse", lse))
        if preset != lse:
            stream.extend(segment(248, b"\x01" + b"".join(word(v) for v in preset)))
            lse = preset
        scan = {**requested, "lse": lse}
        table = bytes(chain.from_iterable((cid, 0) for cid in scan["ids"]))
        sos = bytes((len(scan["ids"]),)) + table + bytes((scan["near"], scan["ilv"], scan["pt"]))
        stream.extend(segment(218, sos))
        entropy = Writer()
        padding.append(scan_image(frame, scan, entropy, decoded, samples, pad_mode))
        stream.extend(entropy.finish())
    stream.extend(b"\xff\xd9")
    return bytes(stream), decoded, padding


def decode(data):
    frame = None
    scans = []
    decoded = None
    padding = []
    lse = (0, 0, 0, 0, 0)
    for marker, payload, entropy in parts(data):
        if marker == 247:
            assert frame is None
            bits, rows, cols, count = payload[0], *[int.from_bytes(payload[n:n+2], "big") for n in (1, 3)], payload[5]
            assert len(payload) == 6 + 3 * count
            components = [{"id": cid, "hSampling": hv >> 4, "vSampling": hv & 15}
                          for cid, hv, _ in zip(payload[6::3], payload[7::3], payload[8::3])]
            frame = {"bits": bits, "height": rows, "width": cols, "components": components}
            decoded = [[] for _ in components]
        elif marker == 248:
            assert len(payload) == 11 and payload[0] == 1
            lse = tuple(int.from_bytes(payload[i:i+2], "big") for i in range(1, 11, 2))
        elif marker == 218:
            n = payload[0]
            near, ilv, pt = payload[-3:]
            assert len(payload) == 4 + 2 * n and pt <= 15 and not any(payload[2:-3:2])
            scan = {"ids": list(payload[1:-3:2]), "near": near, "ilv": ilv, "pt": pt, "lse": lse}
            bits = Reader(entropy)
            padding.append(scan_image(frame, scan, bits, decoded))
            bits.finish()
            scans.append(scan)
        else:
            assert 224 <= marker <= 239 or marker == 254
    assert frame is not None and scans
    assert all(len(plane) == width * height for plane, (width, height) in zip(decoded, geometry(frame)))
    return {"frame": frame, "scans": scans, "samples": decoded, "padding": padding}


def generated_samples(case):
    source = []
    state = case["seed"]
    frame = case["frame"]
    for component, (width, height) in zip(frame["components"], geometry(frame)):
        scan = next(s for s in case["scans"] if component["id"] in s["ids"])
        pt = scan["pt"]
        step = 1 << pt
        near = scan["near"]
        x_max = (1 << frame["bits"]) - 1
        active_maxval = scan.get("lse", [0])[0] or x_max
        cap = min((x_max >> pt) - near, active_maxval)
        samples = []
        for i in range(width * height):
            state = (1664525 * state + 1013904223) & 0xffffffff
            row, col = divmod(i, width)
            if i == 0 or (row == 0 and col < 3):
                q = 0
            elif col == 0 and row % 3 == 1:
                q = cap
            elif col % 5 == 3:
                q = samples[-1] >> pt
            else:
                q = (state >> 9) % (cap + 1)
            samples.append(q * step + (state % step))
        source.append(samples)
    if case.get("wide"):
        source[0][0] = (1 << frame["bits"]) - 1
    return source


def main():
    task = json.load(sys.stdin)
    if task["mode"] == "decode":
        print(json.dumps([decode(bytes.fromhex(stream)) for stream in task["streams"]]))
    else:
        assert task["mode"] == "build"
        results = []
        for case in task["cases"]:
            source = case["source"] if "source" in case else generated_samples(case)
            frame, scans = case["frame"], case["scans"]
            reference, expected, pads = build(frame, scans, source)
            alternate = None
            if sum(pads):
                alt, updated, alt_pads = build(frame, scans, source, "distinct")
                assert alt_pads == pads and alt != reference
                alternate = {"stream": alt.hex(), "samples": updated}
            results.append({"source": source, "stream": reference.hex(), "samples": expected,
                            "padding": pads, "alternate": alternate})
        print(json.dumps(results))


if __name__ == "__main__":
    main()
