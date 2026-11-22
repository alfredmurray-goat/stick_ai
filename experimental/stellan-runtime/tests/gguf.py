import json
import pathlib
import random
import struct
import subprocess
import sys
import tempfile
import unittest


EXECUTABLE = str(pathlib.Path(sys.argv.pop(1)).resolve())


def string(value):
    data = value.encode("utf-8")
    return struct.pack("<Q", len(data)) + data


def model(tensors=None, metadata=None, version=3, alignment=32):
    if tensors is None:
        tensors = [("weight", [3, 2], 0, struct.pack("<6f", 1, 2, 3, -1, -2, -3))]
    if metadata is None:
        metadata = [
            ("general.architecture", 8, string("mamba2")),
            ("general.alignment", 4, struct.pack("<I", alignment)),
            ("tokenizer.ggml.tokens", 9, struct.pack("<IQ", 8, 2) + string("hello") + string("world")),
        ]
    header = b"GGUF" + struct.pack("<IQQ", version, len(tensors), len(metadata))
    for key, kind, data in metadata:
        header += string(key) + struct.pack("<I", kind) + data
    payload = bytearray()
    for name, dimensions, kind, data in tensors:
        header += string(name) + struct.pack("<I", len(dimensions))
        header += struct.pack("<" + "Q" * len(dimensions), *dimensions)
        header += struct.pack("<IQ", kind, len(payload))
        payload += data
        payload += b"\0" * (-len(payload) % alignment)
    return header + b"\0" * (-len(header) % alignment) + payload


class GGUFTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.file = self.root / "model é.gguf"

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, data, *args):
        self.file.write_bytes(data)
        return subprocess.run([EXECUTABLE, *args[:1], str(self.file), *args[1:]], capture_output=True, text=True, encoding="utf-8", timeout=15)

    def test_inspect_versions_and_alignment(self):
        for version in (2, 3):
            for alignment in (16, 32, 64, 4096):
                with self.subTest(version=version, alignment=alignment):
                    result = self.invoke(model(version=version, alignment=alignment), "inspect")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    data = json.loads(result.stdout)
                    self.assertEqual(data["architecture"], "mamba2")
                    self.assertFalse(data["generation_supported"])
                    self.assertEqual(data["tensors"][0]["bytes"], 24)
                    self.assertEqual(data["tensors"][0]["dimensions"], [3, 2])

    def test_matrix_checksums(self):
        for kind, payload in (
            (0, struct.pack("<6f", 1, 2, 3, 4, 5, 6)),
            (1, struct.pack("<6e", 1, 2, 3, 4, 5, 6)),
        ):
            result = self.invoke(model([("w", [3, 2], kind, payload)]), "tensorbench", "w", "2")
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertAlmostEqual(data["output_checksum"], -17.875)
            self.assertGreaterEqual(data["median_matvec_ms"], 0)
            self.assertEqual(data["repetitions"], 2)

    def test_q8_signed_values(self):
        payload = struct.pack("<e32b", 0.5, *range(-16, 16))
        result = self.invoke(model([("w", [32, 1], 8, payload)]), "tensorbench", "w")
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = sum(0.5 * (i - 16) * ((i % 17 - 8) / 8) for i in range(32))
        self.assertAlmostEqual(json.loads(result.stdout)["output_checksum"], expected)

    def test_unicode_and_escaped_names(self):
        name = "weight_é_😀_\n\""
        data = model([(name, [3, 2], 0, struct.pack("<6f", 1, 2, 3, 4, 5, 6))])
        result = self.invoke(data, "inspect")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["tensors"][0]["name"], name)
        result = self.invoke(data, "tensorbench", name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["tensor"], name)

    def test_nonfinite_compute_is_rejected(self):
        data = model([("w", [1, 1], 0, struct.pack("<f", float("nan")))])
        result = self.invoke(data, "tensorbench", "w")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Non-finite", result.stderr)

    def test_q4_packed_scales_and_minima(self):
        scales = [3, 17, 41, 63, 32, 48, 60, 15]
        minima = [61, 7, 22, 49, 63, 38, 16, 51]
        packed = bytearray(12)
        for i in range(4):
            packed[i] = scales[i] | ((scales[i + 4] >> 4) << 6)
            packed[i + 4] = minima[i] | ((minima[i + 4] >> 4) << 6)
            packed[i + 8] = (scales[i + 4] & 15) | ((minima[i + 4] & 15) << 4)
        quant = bytearray(128)
        expected = 0
        for g in range(8):
            for j in range(32):
                q = (g + j) % 16
                quant[g // 2 * 32 + j] |= q << (g % 2 * 4)
                i = g * 32 + j
                expected += (0.03125 * scales[g] * q - 0.015625 * minima[g]) * ((i % 17 - 8) / 8)
        payload = struct.pack("<ee", 0.03125, 0.015625) + packed + quant
        result = self.invoke(model([("w", [256, 1], 12, payload)]), "tensorbench", "w")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertAlmostEqual(json.loads(result.stdout)["output_checksum"], expected, places=4)

    def test_every_truncated_header(self):
        data = model()
        payload_start = len(data) - 32
        for size in range(payload_start + 24):
            with self.subTest(size=size):
                result = self.invoke(data[:size], "inspect")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("stellan-runtime:", result.stderr)

    def test_invalid_headers(self):
        valid = model()
        cases = [b"NOPE" + valid[4:], model(version=1), model(version=256)]
        cases.append(valid[:8] + struct.pack("<Q", 100001) + valid[16:])
        cases.append(valid[:16] + struct.pack("<Q", 100001) + valid[24:])
        for alignment in (0, 3, 2097152):
            metadata = [("general.architecture", 8, string("mamba2")), ("general.alignment", 4, struct.pack("<I", alignment))]
            cases.append(model(metadata=metadata))
        for data in cases:
            with self.subTest(data=data[:24]):
                self.assertNotEqual(self.invoke(data, "inspect").returncode, 0)

    def test_malformed_utf8(self):
        for bad in (b"\xff", b"\xc0\x80", b"\xed\xa0\x80", b"\xf4\x90\x80\x80", b"\xe2\x82"):
            data = model(metadata=[("general.architecture", 8, struct.pack("<Q", len(bad)) + bad)])
            self.assertNotEqual(self.invoke(data, "inspect").returncode, 0)

    def test_seeded_mutations_do_not_crash(self):
        generator = random.Random(20261122)
        source = model()
        for _ in range(100):
            data = bytearray(source)
            for _ in range(generator.randrange(1, 5)):
                position = generator.randrange(len(data))
                data[position] ^= 1 << generator.randrange(8)
            result = self.invoke(data, "inspect")
            self.assertIn(result.returncode, (0, 1), result.stderr)
            if result.returncode == 0:
                json.loads(result.stdout)

    def test_invalid_metadata(self):
        cases = [
            [],
            [("general.architecture", 4, struct.pack("<I", 1))],
            [("general.architecture", 8, string(""))],
            [("general.architecture", 8, string("a")), ("general.architecture", 8, string("b"))],
            [("bad", 99, b"")],
            [("bad", 9, struct.pack("<IQ", 9, 1))],
            [("bad", 9, struct.pack("<IQ", 4, 10000001))],
        ]
        for metadata in cases:
            self.assertNotEqual(self.invoke(model(metadata=metadata), "inspect").returncode, 0)

    def test_invalid_tensors(self):
        cases = [
            [("w", [], 0, b"")],
            [("w", [0], 0, b"")],
            [("w", [1, 1, 1, 1, 1], 0, b"\0" * 4)],
            [("w", [2**63, 4], 0, b"")],
            [("w", [1], 999, b"\0" * 4)],
            [("w", [255], 12, b"\0" * 144)],
            [("", [1], 0, b"\0" * 4)],
            [("w", [1], 0, b"\0" * 4), ("w", [1], 0, b"\0" * 4)],
        ]
        for tensors in cases:
            self.assertNotEqual(self.invoke(model(tensors), "inspect").returncode, 0)

    def test_overlapping_and_misaligned_offsets(self):
        data = bytearray(model([("a", [1], 0, b"\0" * 4), ("b", [1], 0, b"\0" * 4)]))
        offset = data.index(string("b")) + len(string("b")) + 4 + 8 + 4
        for value in (0, 1, 2**64 - 1):
            changed = data[:]
            struct.pack_into("<Q", changed, offset, value)
            self.assertNotEqual(self.invoke(changed, "inspect").returncode, 0)

    def test_unsupported_compute_is_explicit(self):
        data = model([("w", [256, 1], 14, b"\0" * 210)])
        self.assertEqual(self.invoke(data, "inspect").returncode, 0)
        result = self.invoke(data, "tensorbench", "w")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No compute kernel", result.stderr)

    def test_bad_cli(self):
        for args in (("tensorbench", "missing"), ("tensorbench", "weight", "0"), ("tensorbench", "weight", "101"), ("tensorbench", "weight", "2x"), ("inspect", "extra")):
            self.assertNotEqual(self.invoke(model(), *args).returncode, 0)
        result = subprocess.run([EXECUTABLE, "inspect", str(self.root / "missing.gguf")], capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
