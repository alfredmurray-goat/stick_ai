"""The eye (Pixtral image encoder + Mistral 3 projector) against an independent reference.

The reference follows Hugging Face's PixtralVisionModel and Mistral3MultiModalProjector: weights in
their original layout, 2D RoPE with rotate_half, unfold-ordered patch merging and exact GELU. The GGUF
is written the way llama.cpp converts Mistral Small 3.1 (q/k rows permuted to adjacent pairs), so a
match proves Stellan-Run reads real mmproj files the way the original model computes.
"""
import hashlib
import math
import pathlib
import random
import struct
import subprocess
import tempfile
import unittest

import gguf as fixtures

EXECUTABLE = fixtures.EXECUTABLE
string = fixtures.string

WIDTH, HEADS, FEED, PATCH, MERGE, LAYERS, HIDDEN, OUTPUT, EDGE = 32, 4, 48, 2, 2, 2, 24, 20, 12
HEAD = WIDTH // HEADS
MEAN, STD = [0.48145466, 0.4578275, 0.40821073], [0.26862954, 0.26130258, 0.27577711]


def half(value):
    return struct.unpack("<e", struct.pack("<e", value))[0]


def uint(value):
    return struct.pack("<I", value)


def floats_array(values):
    return struct.pack("<IQ", 6, len(values)) + struct.pack("<" + "f" * len(values), *values)


class Weights:
    def __init__(self, seed):
        self.random = random.Random(seed)

    def matrix(self, rows, columns, scale):
        return [[half(self.random.uniform(-scale, scale)) for _ in range(columns)] for _ in range(rows)]

    def vector(self, count, centre=1.0, spread=0.2):
        return [half(centre + self.random.uniform(-spread, spread)) for _ in range(count)]


def build(seed=4, merge=MERGE, projector="pixtral"):
    w = Weights(seed)
    p = {
        "patch": w.matrix(WIDTH, 3 * PATCH * PATCH, 0.4),
        "pre": w.vector(WIDTH),
        "layers": [],
        "merger_norm": w.vector(WIDTH),
        "merger": w.matrix(WIDTH, WIDTH * merge * merge, 0.15),
        "mm1": w.matrix(HIDDEN, WIDTH, 0.3), "mm1_bias": w.vector(HIDDEN, 0.0, 0.1),
        "mm2": w.matrix(OUTPUT, HIDDEN, 0.3),
        "break": w.vector(OUTPUT, 0.0, 1.0),
    }
    for _ in range(LAYERS):
        p["layers"].append({
            "ln1": w.vector(WIDTH), "q": w.matrix(WIDTH, WIDTH, 0.3), "k": w.matrix(WIDTH, WIDTH, 0.3),
            "v": w.matrix(WIDTH, WIDTH, 0.3), "o": w.matrix(WIDTH, WIDTH, 0.2), "ln2": w.vector(WIDTH),
            "gate": w.matrix(FEED, WIDTH, 0.3), "up": w.matrix(FEED, WIDTH, 0.3), "down": w.matrix(WIDTH, FEED, 0.2),
        })
    return p


def permute(rows):
    # llama.cpp's LlamaModel.permute for one block of heads: within each head, row i of the first half and
    # row i of the second half become neighbours (2i, 2i + 1).
    result = []
    for h in range(HEADS):
        head = rows[h * HEAD:(h + 1) * HEAD]
        for i in range(HEAD // 2):
            result += [head[i], head[i + HEAD // 2]]
    return result


def q8_0(rows):
    """Quantises rows to Q8_0 (f16 scale + 32 int8 per block); returns the bytes and the values a reader sees."""
    data, seen = bytearray(), []
    for row in rows:
        out = []
        for start in range(0, len(row), 32):
            block = row[start:start + 32]
            scale = half(max(abs(v) for v in block) / 127)
            q = [max(-127, min(127, round(v / scale))) if scale else 0 for v in block]
            data += struct.pack("<e", scale) + struct.pack("<32b", *q)
            out += [scale * v for v in q]
        seen.append(out)
    return bytes(data), seen


def gguf_file(p, merge=MERGE, projector="pixtral", types=None):
    types = types or {}
    tensors = []

    def add(name, dims, values, kind=0):
        fmt = "e" if kind == 1 else "f"
        tensors.append((name, dims, kind, struct.pack("<" + fmt * len(values), *values)))

    def matrix(name, rows, kind=0):
        kind = types.get(name, kind)
        if kind == 8:
            data, _ = q8_0(rows)
            tensors.append((name, [len(rows[0]), len(rows)], 8, data))
        else:
            add(name, [len(rows[0]), len(rows)], [x for row in rows for x in row], kind)

    add("v.patch_embd.weight", [PATCH, PATCH, 3, WIDTH], [x for row in p["patch"] for x in row], 1)
    add("v.pre_ln.weight", [WIDTH], p["pre"])
    for i, layer in enumerate(p["layers"]):
        prefix = f"v.blk.{i}."
        add(prefix + "ln1.weight", [WIDTH], layer["ln1"])
        matrix(prefix + "attn_q.weight", permute(layer["q"]))
        matrix(prefix + "attn_k.weight", permute(layer["k"]), 1)
        matrix(prefix + "attn_v.weight", layer["v"])
        matrix(prefix + "attn_out.weight", layer["o"])
        add(prefix + "ln2.weight", [WIDTH], layer["ln2"])
        matrix(prefix + "ffn_gate.weight", layer["gate"])
        matrix(prefix + "ffn_up.weight", layer["up"], 1)
        matrix(prefix + "ffn_down.weight", layer["down"])
    if merge > 1:
        add("mm.input_norm.weight", [WIDTH], p["merger_norm"])
        matrix("mm.patch_merger.weight", p["merger"])
    matrix("mm.1.weight", p["mm1"])
    add("mm.1.bias", [HIDDEN], p["mm1_bias"])
    matrix("mm.2.weight", p["mm2"], 1)
    add("v.token_embd.img_break", [OUTPUT], p["break"])
    metadata = [
        ("general.architecture", 8, string("clip")),
        ("clip.projector_type", 8, string(projector)),
        ("clip.has_vision_encoder", 7, b"\x01"),
        ("clip.vision.embedding_length", 4, uint(WIDTH)),
        ("clip.vision.feed_forward_length", 4, uint(FEED)),
        ("clip.vision.block_count", 4, uint(LAYERS)),
        ("clip.vision.attention.head_count", 4, uint(HEADS)),
        ("clip.vision.attention.layer_norm_epsilon", 6, struct.pack("<f", 1e-5)),
        ("clip.vision.patch_size", 4, uint(PATCH)),
        ("clip.vision.image_size", 4, uint(EDGE)),
        ("clip.vision.image_mean", 9, floats_array(MEAN)),
        ("clip.vision.image_std", 9, floats_array(STD)),
        ("clip.use_silu", 7, b"\x01"),
    ]
    if merge > 1:
        metadata.append(("clip.vision.spatial_merge_size", 4, uint(merge)))
    return fixtures.model(tensors, metadata)


def rms(values, weights):
    scale = 1 / math.sqrt(sum(x * x for x in values) / len(values) + 1e-5)
    return [x * scale * w for x, w in zip(values, weights)]


def linear(rows, values, bias=None):
    out = [sum(a * b for a, b in zip(row, values)) for row in rows]
    return [o + b for o, b in zip(out, bias)] if bias else out


def reference(p, rgb, width, height, merge=MERGE):
    f32 = lambda x: struct.unpack("<f", struct.pack("<f", x))[0]
    pixels = [[[f32((rgb[(y * width + x) * 3 + c] / 255.0 - MEAN[c]) / STD[c]) for x in range(width)] for y in range(height)] for c in range(3)]
    rows, columns = height // PATCH, width // PATCH
    hidden = []
    for py in range(rows):
        for px in range(columns):
            patch = [pixels[c][py * PATCH + y][px * PATCH + x] for c in range(3) for y in range(PATCH) for x in range(PATCH)]
            hidden.append(rms(linear(p["patch"], patch), p["pre"]))
    # Hugging Face PixtralRotaryEmbedding + apply_rotary_pos_emb (rotate_half).
    freqs = [1.0 / (10000.0 ** (i / HEAD)) for i in range(0, HEAD, 2)]
    def rope(vector, y, x):
        inv = [y * f for f in freqs[0::2]] + [x * f for f in freqs[1::2]]
        angles = inv + inv
        out = []
        for h in range(HEADS):
            head = vector[h * HEAD:(h + 1) * HEAD]
            rotated = [-v for v in head[HEAD // 2:]] + head[:HEAD // 2]
            out += [a * math.cos(t) + r * math.sin(t) for a, r, t in zip(head, rotated, angles)]
        return out
    tokens = len(hidden)
    for layer in p["layers"]:
        normed = [rms(h, layer["ln1"]) for h in hidden]
        q = [rope(linear(layer["q"], n), t // columns, t % columns) for t, n in enumerate(normed)]
        k = [rope(linear(layer["k"], n), t // columns, t % columns) for t, n in enumerate(normed)]
        v = [linear(layer["v"], n) for n in normed]
        attended = []
        for t in range(tokens):
            out = []
            for h in range(HEADS):
                s = slice(h * HEAD, (h + 1) * HEAD)
                scores = [sum(a * b for a, b in zip(q[t][s], k[j][s])) / math.sqrt(HEAD) for j in range(tokens)]
                top = max(scores)
                e = [math.exp(x - top) for x in scores]
                total = sum(e)
                out += [sum(e[j] / total * v[j][s][i] for j in range(tokens)) for i in range(HEAD)]
            attended.append(out)
        hidden = [[a + b for a, b in zip(h, linear(layer["o"], o))] for h, o in zip(hidden, attended)]
        normed = [rms(h, layer["ln2"]) for h in hidden]
        mixed = []
        for n in normed:
            g, u = linear(layer["gate"], n), linear(layer["up"], n)
            mixed.append(linear(layer["down"], [a / (1 + math.exp(-a)) * b for a, b in zip(g, u)]))
        hidden = [[a + b for a, b in zip(h, m)] for h, m in zip(hidden, mixed)]
    if merge > 1:
        # Mistral3PatchMerger: grid -> unfold(kernel=merge, stride=merge) -> merging_layer.
        hidden = [rms(h, p["merger_norm"]) for h in hidden]
        merged = []
        for r in range(rows // merge):
            for c in range(columns // merge):
                vector = [hidden[(r * merge + ky) * columns + c * merge + kx][ch] for ch in range(WIDTH) for ky in range(merge) for kx in range(merge)]
                merged.append(linear(p["merger"], vector))
        hidden = merged
    gelu = lambda x: 0.5 * x * (1 + math.erf(x / math.sqrt(2)))
    return [linear(p["mm2"], [gelu(x) for x in linear(p["mm1"], h, p["mm1_bias"])]) for h in hidden]


class EyeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def see(self, data, rgb, width, height, *extra, sha=None, env=None):
        model = self.root / "mmproj é.gguf"
        model.write_bytes(data)
        image = self.root / "image.rgb"
        image.write_bytes(bytes(rgb))
        out = self.root / "embeddings.f32"
        args = [EXECUTABLE, "see", str(model), sha or hashlib.sha256(data).hexdigest(), str(image), str(width), str(height), *extra, "--out", str(out)]
        result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", timeout=60, env={**__import__("os").environ, **(env or {})})
        values = list(struct.unpack("<" + "f" * (out.stat().st_size // 4), out.read_bytes())) if result.returncode == 0 else []
        return result, values

    def test_matches_the_reference_mistral3_computation(self):
        p = build()
        rng = random.Random(11)
        width, height = 8, 12
        rgb = [rng.randrange(256) for _ in range(width * height * 3)]
        for threads, env in (("1", {}), ("3", {}), ("2", {"STELLAN_RUNTIME_SCALAR": "1"})):
            with self.subTest(threads=threads, env=env):
                result, values = self.see(gguf_file(p), rgb, width, height, threads, env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                summary = __import__("json").loads(result.stdout)
                self.assertEqual((summary["rows"], summary["columns"], summary["output_width"], summary["layers"], summary["break_token"]), (3, 2, OUTPUT, LAYERS, True))
                expected = [x for row in reference(p, rgb, width, height) for x in row]
                self.assertEqual(len(values), len(expected))
                worst = max(abs(a - b) / (1e-3 + abs(b)) for a, b in zip(values, expected))
                self.assertLess(worst, 2e-3, f"largest relative difference {worst}")

    def test_q8_0_weights_and_the_portable_fallback(self):
        # Q8_0 weights take the int8 path (inputs quantised in 32-value blocks); STELLAN_RUNTIME_SCALAR forces
        # the portable code used on computers without AVX2. Both must stay close to the exact reference.
        p = build(seed=21)
        names = [f"v.blk.{i}.{n}.weight" for i in range(LAYERS) for n in ("attn_v", "attn_out", "ffn_gate")] + ["mm.patch_merger.weight", "mm.1.weight"]
        types = {name: 8 for name in names}
        seen = dict(p)
        seen["layers"] = [dict(layer) for layer in p["layers"]]
        for i, layer in enumerate(seen["layers"]):
            for key, tensor in (("v", "attn_v"), ("o", "attn_out"), ("gate", "ffn_gate")):
                layer[key] = q8_0(layer[key])[1]
        seen["merger"] = q8_0(p["merger"])[1]
        seen["mm1"] = q8_0(p["mm1"])[1]
        rng = random.Random(3)
        rgb = [rng.randrange(256) for _ in range(8 * 8 * 3)]
        expected = [x for row in reference(seen, rgb, 8, 8) for x in row]
        for env in ({}, {"STELLAN_RUNTIME_SCALAR": "1"}):
            with self.subTest(env=env):
                result, values = self.see(gguf_file(p, types=types), rgb, 8, 8, "2", env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                dot = sum(a * b for a, b in zip(values, expected))
                cosine = dot / math.sqrt(sum(a * a for a in values) * sum(b * b for b in expected))
                self.assertGreater(cosine, 0.9995)
                self.assertLess(max(abs(a - b) for a, b in zip(values, expected)), 0.05 * max(abs(b) for b in expected))

    def test_without_patch_merging(self):
        p = build(seed=9, merge=1)
        rng = random.Random(5)
        rgb = [rng.randrange(256) for _ in range(4 * 6 * 3)]
        result, values = self.see(gguf_file(p, merge=1), rgb, 4, 6)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = [x for row in reference(p, rgb, 4, 6, merge=1) for x in row]
        self.assertEqual(len(values), len(expected))
        self.assertLess(max(abs(a - b) / (1e-3 + abs(b)) for a, b in zip(values, expected)), 2e-3)

    def test_resizes_large_images_to_whole_merged_patches(self):
        data = gguf_file(build())
        for (width, height), shape in (((20, 20), (12, 12)), ((9, 5), (12, 8)), ((1, 1), (4, 4)), ((30, 6), (12, 4))):
            with self.subTest(size=(width, height)):
                result, values = self.see(data, [128] * (width * height * 3), width, height)
                self.assertEqual(result.returncode, 0, result.stderr)
                summary = __import__("json").loads(result.stdout)
                self.assertEqual((summary["prepared_width"], summary["prepared_height"]), shape)
                self.assertEqual(len(values), shape[0] // 4 * shape[1] // 4 * OUTPUT)
                self.assertTrue(all(math.isfinite(v) for v in values))

    def test_refuses_wrong_hash_type_and_pixel_count(self):
        data = gguf_file(build())
        result, _ = self.see(data, [0] * 8 * 12 * 3, 8, 12, sha="0" * 64)
        self.assertNotEqual(result.returncode, 0); self.assertIn("hash mismatch", result.stderr)
        result, _ = self.see(data, [0] * 10, 8, 12)
        self.assertNotEqual(result.returncode, 0); self.assertIn("does not match", result.stderr)
        result, _ = self.see(gguf_file(build(), projector="llava"), [0] * 8 * 12 * 3, 8, 12)
        self.assertNotEqual(result.returncode, 0); self.assertIn("Pixtral", result.stderr)


if __name__ == "__main__":
    unittest.main(argv=["vision"])
