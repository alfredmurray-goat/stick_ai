import hashlib
import json
import math
import os
import random
import struct
import subprocess
import unittest

import gguf as fixtures

EXECUTABLE = fixtures.EXECUTABLE
model = fixtures.model
string = fixtures.string


def vector(values):
    return list(struct.unpack("<" + "f" * len(values), struct.pack("<" + "f" * len(values), *values)))


def dense(weights, values):
    return [sum(a * b for a, b in zip(row, values)) for row in weights]


def cache_values(values, quantized):
    if not quantized:
        return list(struct.unpack('<' + 'e' * len(values), struct.pack('<' + 'e' * len(values), *values)))
    result = []
    for start in range(0, len(values), 32):
        block = values[start:start+32]
        maximum = max(abs(v) for v in block)
        scale = struct.unpack('<e', struct.pack('<e', maximum / 127))[0]
        if maximum and not scale: scale = 2 ** -24
        result += [scale * min(127, max(-127, round(value / scale))) if scale else 0 for value in block]
    return result

def norm(values, weights):
    scale = 1 / math.sqrt(sum(x * x for x in values) / len(values) + 1e-5)
    return [x * scale * w for x, w in zip(values, weights)]


def silu(x):
    return x / (1 + math.exp(-x))


class Fixture:
    def __init__(self, architecture, groups=1, bpe=False):
        self.random = random.Random(8234)
        self.weights = {}
        self.tensors = []
        self.architecture = architecture
        self.groups = groups
        tokens = ["<unk>", "<s>", "</s>"] + [f"<0x{i:02X}>" for i in range(256)]
        if bpe:
            direct = set(range(33, 127)) | set(range(161, 173)) | set(range(174, 256))
            extra = iter(range(256, 512))
            tokens = ["<unk>", "<s>", "</s>"] + [chr(i if i in direct else next(extra)) for i in range(256)] + ["AB"]
        self.metadata = [
            ("general.architecture", 8, string(architecture)),
            ("tokenizer.ggml.model", 8, string("gpt2" if bpe else "llama")),
            ("tokenizer.ggml.bos_token_id", 4, struct.pack("<I", 1)),
            ("tokenizer.ggml.eos_token_id", 4, struct.pack("<I", 2)),
            ("tokenizer.ggml.tokens", 9, struct.pack("<IQ", 8, len(tokens)) + b"".join(string(t) for t in tokens)),
            ("tokenizer.ggml.scores", 9, struct.pack("<IQ", 6, len(tokens)) + struct.pack("<" + "f" * len(tokens), *([0] * len(tokens)))),
            ("tokenizer.ggml.token_type", 9, struct.pack("<IQ", 5, len(tokens)) + struct.pack("<" + "i" * len(tokens), *([2, 3, 3] + ([1] * 257 if bpe else [6] * 256))))
        ]
        if bpe:
            self.metadata += [("tokenizer.ggml.pre", 8, string("tekken")), ("tokenizer.ggml.merges", 9, struct.pack("<IQ", 8, 1) + string("A B"))]
        config = {"embedding_length": 4, "block_count": 2, "attention.layer_norm_rms_epsilon": 1e-5}
        if architecture == "mamba2":
            config.update({"ssm.inner_size": 8, "ssm.state_size": 2, "ssm.time_step_rank": 2 * groups, "ssm.group_count": groups, "ssm.conv_kernel": 4})
        else:
            config.update({"attention.head_count": 2, "attention.head_count_kv": 1, "attention.key_length": 2, "attention.value_length": 2, "feed_forward_length": 6, "rope.dimension_count": 2, "rope.freq_base": 10000.0})
        for key, value in config.items():
            self.metadata.append((architecture + "." + key, 6 if isinstance(value, float) else 4, struct.pack("<f" if isinstance(value, float) else "<I", value)))
        self.add("token_embd.weight", [4, len(tokens)])
        self.add("output.weight", [4, len(tokens)])
        self.add("output_norm.weight", [4], ones=True)
        for layer in range(2):
            prefix = f"blk.{layer}."
            self.add(prefix + "attn_norm.weight", [4], ones=True)
            if architecture == "mamba2":
                self.add(prefix + "ssm_in.weight", [4, 16 + 6 * groups])
                self.add(prefix + "ssm_out.weight", [8, 4])
                self.add(prefix + "ssm_conv1d.weight", [4, 8 + 4 * groups])
                self.add(prefix + "ssm_conv1d.bias", [8 + 4 * groups])
                self.add(prefix + "ssm_dt.bias", [2 * groups])
                self.add(prefix + "ssm_a", [1, 2 * groups], values=[-0.2 - 0.1 * i for i in range(2 * groups)])
                self.add(prefix + "ssm_d", [1, 2 * groups], values=[0.1 + 0.1 * i for i in range(2 * groups)])
                self.add(prefix + "ssm_norm.weight", [8 // groups, groups], ones=True)
            else:
                for name, shape in [("attn_q.weight", [4, 4]), ("attn_k.weight", [4, 2]), ("attn_v.weight", [4, 2]), ("attn_output.weight", [4, 4]), ("ffn_gate.weight", [4, 6]), ("ffn_up.weight", [4, 6]), ("ffn_down.weight", [6, 4])]:
                    self.add(prefix + name, shape)
                self.add(prefix + "ffn_norm.weight", [4], ones=True)
        self.state = [[[0.0] * 2 for _ in range(8)] for _ in range(2)]
        self.history = [[[0.0] * 3 for _ in range(8 + 4 * groups)] for _ in range(2)]
        self.quantized_cache = False
        self.keys = [[], []]
        self.values = [[], []]

    def add(self, name, shape, ones=False, values=None):
        count = math.prod(shape)
        values = vector(values if values is not None else [1.0 if ones else self.random.uniform(-0.25, 0.25) for _ in range(count)])
        self.weights[name] = [values[i:i + shape[0]] for i in range(0, count, shape[0])] if len(shape) == 2 else values
        self.tensors.append((name, shape, 0, struct.pack("<" + "f" * count, *values)))

    def bytes(self):
        return model(self.tensors, self.metadata)

    def step(self, token):
        w = self.weights
        hidden = w["token_embd.weight"][token][:]
        for layer in range(2):
            prefix = f"blk.{layer}."
            x = norm(hidden, w[prefix + "attn_norm.weight"])
            if self.architecture == "mamba2":
                projected = dense(w[prefix + "ssm_in.weight"], x)
                conv = []
                for ch in range(8 + 4 * self.groups):
                    window = self.history[layer][ch] + [projected[8 + ch]]
                    self.history[layer][ch] = window[1:]
                    conv.append(silu(sum(a * b for a, b in zip(window, w[prefix + "ssm_conv1d.weight"][ch])) + w[prefix + "ssm_conv1d.bias"][ch]))
                mixed = []
                for ch in range(8):
                    head = ch // (4 // self.groups)
                    dt = math.log1p(math.exp(projected[16 + 4 * self.groups + head] + w[prefix + "ssm_dt.bias"][head]))
                    decay = math.exp(dt * w[prefix + "ssm_a"][head][0])
                    for n in range(2):
                        self.state[layer][ch][n] = decay * self.state[layer][ch][n] + dt * conv[8 + (ch // (8 // self.groups)) * 2 + n] * conv[ch]
                    y = sum(conv[8 + self.groups * 2 + (ch // (8 // self.groups)) * 2 + n] * self.state[layer][ch][n] for n in range(2)) + w[prefix + "ssm_d"][head][0] * conv[ch]
                    mixed.append(y * silu(projected[ch]))
                mixed = [value for group in range(self.groups) for value in norm(mixed[group * (8 // self.groups):(group + 1) * (8 // self.groups)], w[prefix + "ssm_norm.weight"][group])]
                update = dense(w[prefix + "ssm_out.weight"], mixed)
                hidden = [a + b for a, b in zip(hidden, update)]
            else:
                q = dense(w[prefix + "attn_q.weight"], x)
                k = dense(w[prefix + "attn_k.weight"], x)
                v = dense(w[prefix + "attn_v.weight"], x)
                position = len(self.keys[layer])
                for values in (q, k):
                    for i in range(0, len(values), 2):
                        a, b = values[i:i + 2]
                        values[i:i + 2] = [a * math.cos(position) - b * math.sin(position), a * math.sin(position) + b * math.cos(position)]
                self.keys[layer].append(cache_values(k, self.quantized_cache))
                self.values[layer].append(cache_values(v, self.quantized_cache))
                attention = []
                for head in range(2):
                    scores = [sum(a * b for a, b in zip(q[head * 2:head * 2 + 2], key)) / math.sqrt(2) for key in self.keys[layer]]
                    probabilities = [math.exp(score - max(scores)) for score in scores]
                    probabilities = [p / sum(probabilities) for p in probabilities]
                    attention.extend([sum(p * value[i] for p, value in zip(probabilities, self.values[layer])) for i in range(2)])
                hidden = [a + b for a, b in zip(hidden, dense(w[prefix + "attn_output.weight"], attention))]
                x = norm(hidden, w[prefix + "ffn_norm.weight"])
                gate = [silu(a) * b for a, b in zip(dense(w[prefix + "ffn_gate.weight"], x), dense(w[prefix + "ffn_up.weight"], x))]
                hidden = [a + b for a, b in zip(hidden, dense(w[prefix + "ffn_down.weight"], gate))]
        return dense(w["output.weight"], norm(hidden, w["output_norm.weight"]))


class ExecutionTests(unittest.TestCase):
    setUp = fixtures.GGUFTests.setUp
    tearDown = fixtures.GGUFTests.tearDown
    invoke = fixtures.GGUFTests.invoke
    def test_both_architectures_against_independent_reference(self):
        for architecture in ("mamba2", "llama"):
            for threads in (1, 3):
                with self.subTest(architecture=architecture, threads=threads):
                    fixture = Fixture(architecture)
                    data = fixture.bytes()
                    digest = hashlib.sha256(data).hexdigest()
                    result = self.invoke(data, "decode", digest, "1,68", "4", str(threads))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    events = [json.loads(line) for line in result.stdout.splitlines()]
                    generated = [event for event in events if event["event"] == "token"]
                    fixture.step(1)
                    logits = fixture.step(68)
                    for event in generated:
                        expected = sorted(range(len(logits)), key=lambda i: logits[i], reverse=True)[:10]
                        self.assertEqual([item["id"] for item in event["top"]], expected)
                        for item in event["top"]:
                            self.assertAlmostEqual(item["logit"], logits[item["id"]], delta=0.0001)
                        logits = fixture.step(expected[0])
                    self.assertEqual(events[-1]["model_sha256"], digest)
                    self.assertGreater(events[-1]["state_bytes"], 0)

    def test_sessions_match_fresh_runs_and_reset_diverged_prefixes(self):
        for architecture in ("mamba2", "llama"):
            with self.subTest(architecture=architecture):
                data = Fixture(architecture).bytes()
                digest = hashlib.sha256(data).hexdigest()
                self.file.write_bytes(data)
                def fresh(tokens, count):
                    result = subprocess.run([EXECUTABLE, "decode", str(self.file), digest, ','.join(map(str, tokens)), str(count), "2", "64"], capture_output=True, text=True, encoding="utf-8", timeout=15, check=True)
                    return [json.loads(line)["id"] for line in result.stdout.splitlines() if json.loads(line)["event"] == "token"]
                first = fresh([1, 68], 2)
                second_prompt = [1, 68] + first + [69]
                requests = [([1, 68], 2), (second_prompt, 3), ([1, 99], 2), ([1], 2)]
                lines = ''.join(f'{index} {count} ' + ','.join(map(str, tokens)) + '\n' for index, (tokens, count) in enumerate(requests, 1))
                result = subprocess.run([EXECUTABLE, "serve", str(self.file), digest, "2", "64"], input=lines, capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
                events = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual(sum(e['event'] == 'ready' for e in events), 1)
                for index, (tokens, count) in enumerate(requests, 1):
                    actual = [e['id'] for e in events if e['event'] == 'token' and e['request_id'] == index]
                    self.assertEqual(actual, fresh(tokens, count))
                    metrics = next(e for e in events if e['event'] == 'finished' and e['request_id'] == index)
                    self.assertEqual(metrics['reused_tokens'], 2 + max(0, len(first) - 1) if index == 2 else 0)

    def test_batched_prefill_preserves_logits_across_chunk_boundaries(self):
        for size in (15, 16, 17, 31, 32, 33, 63, 64, 65):
            fixture = Fixture("mamba2")
            data = fixture.bytes(); self.file.write_bytes(data)
            tokens = [1] + [68 + i % 8 for i in range(size - 1)]
            for token in tokens: logits = fixture.step(token)
            digest = hashlib.sha256(data).hexdigest()
            result = subprocess.run([EXECUTABLE, "decode", str(self.file), digest, ','.join(map(str, tokens)), "1", "2", "128"], capture_output=True, text=True, encoding="utf-8", timeout=15, check=True)
            event = next(json.loads(line) for line in result.stdout.splitlines() if json.loads(line)['event'] == 'token')
            self.assertEqual(event['id'], max(range(len(logits)), key=lambda i: logits[i]))
            for item in event['top']: self.assertAlmostEqual(item['logit'], logits[item['id']], delta=0.0001)

    def test_transformer_prefill_skips_intermediate_output_without_changing_logits(self):
        fixture = Fixture("llama")
        data = fixture.bytes(); self.file.write_bytes(data)
        tokens = [1] + [68 + i % 8 for i in range(16)]
        for token in tokens: logits = fixture.step(token)
        result = subprocess.run([EXECUTABLE, "decode", str(self.file), hashlib.sha256(data).hexdigest(), ','.join(map(str, tokens)), "1", "3", "64"], capture_output=True, text=True, encoding="utf-8", timeout=15, check=True)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        progress = [event['completed'] for event in events if event['event'] == 'prompt_progress']
        self.assertEqual(progress, list(range(1, len(tokens) + 1)))
        event = next(event for event in events if event['event'] == 'token')
        self.assertEqual(event['id'], max(range(len(logits)), key=lambda i: logits[i]))
        for item in event['top']: self.assertAlmostEqual(item['logit'], logits[item['id']], delta=0.0001)

    def test_session_errors_clear_state_and_hash_tampering_is_refused(self):
        data = Fixture("mamba2").bytes(); self.file.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        result = subprocess.run([EXECUTABLE, "serve", str(self.file), digest, "2", "16"], input='1 2 1,68\n2 2 1,-1\n3 2 1,68\n4 16 1,68\n', capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([e['request_id'] for e in events if e['event'] == 'error'], [2, 4])
        self.assertEqual(next(e for e in events if e['event'] == 'finished' and e['request_id'] == 3)['reused_tokens'], 0)
        result = subprocess.run([EXECUTABLE, "serve", str(self.file), "0" * 64, "2", "16"], input='1 1 1\n', capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertNotEqual(result.returncode, 0); self.assertNotIn('ready', result.stdout)

    def test_tagged_session_stops_naturally_and_keeps_its_prompt_state(self):
        fixture = Fixture('mamba2')
        with __import__('tempfile').TemporaryDirectory() as root:
            path = __import__('pathlib').Path(root) / 'tagged.gguf'
            original = fixture.bytes(); path.write_bytes(original)
            digest = hashlib.sha256(original).hexdigest()
            base = subprocess.run([EXECUTABLE, 'serve', str(path), digest, '2', '128'], input='1 1 1,68\n', capture_output=True, text=True, check=True)
            token = next(e['id'] for e in map(json.loads, base.stdout.splitlines()) if e['event']=='token')
            tokens = ['<unk>', '<s>', '</s>'] + [f'<0x{i:02X}>' for i in range(256)]
            types = [2,3,3]+[6]*256
            tokens[token]='<done>Ready</done>'; types[token]=1
            fixture.metadata=[(key,kind,struct.pack('<IQ',8,len(tokens))+b''.join(string(t) for t in tokens) if key=='tokenizer.ggml.tokens' else struct.pack('<IQ',5,len(types))+struct.pack('<'+'i'*len(types),*types) if key=='tokenizer.ggml.token_type' else data) for key,kind,data in fixture.metadata]
            data=fixture.bytes();path.write_bytes(data);digest=hashlib.sha256(data).hexdigest()
            result=subprocess.run([EXECUTABLE,'serve',str(path),digest,'2','128','--tagged'],input='1 16 1,68\n2 16 1,68\n',capture_output=True,text=True,check=True)
            events=list(map(json.loads,result.stdout.splitlines()))
            finished=[e for e in events if e['event']=='finished']
            self.assertEqual([e['generated'] for e in finished],[1,1])
            self.assertEqual([e['stop_reason'] for e in finished],['tagged','tagged'])
            self.assertEqual(finished[1]['reused_tokens'],2)

    def test_parallel_recurrent_groups_match_independent_reference(self):
        for groups in (1, 2, 4):
            for threads in (1, 2, 3, 8):
                fixture = Fixture("mamba2", groups)
                data = fixture.bytes(); self.file.write_bytes(data)
                tokens = [1, 68, 69, 70, 71]
                for token in tokens: logits = fixture.step(token)
                result = subprocess.run([EXECUTABLE, "decode", str(self.file), hashlib.sha256(data).hexdigest(), ','.join(map(str, tokens)), "3", str(threads)], capture_output=True, text=True, encoding="utf-8", timeout=15, check=True)
                for event in (json.loads(line) for line in result.stdout.splitlines()):
                    if event['event'] != 'token':
                        continue
                    self.assertEqual(event['id'], max(range(len(logits)), key=lambda i: logits[i]))
                    for item in event['top']:
                        self.assertAlmostEqual(item['logit'], logits[item['id']], delta=0.0001)
                    logits = fixture.step(event['id'])

    def test_quantized_transformer_cache_matches_independent_reference(self):
        fixture = Fixture("llama"); fixture.quantized_cache = True
        data = fixture.bytes(); self.file.write_bytes(data)
        tokens = [1, 68, 69, 70, 71]
        for token in tokens: logits = fixture.step(token)
        result = subprocess.run([EXECUTABLE, "decode", str(self.file), hashlib.sha256(data).hexdigest(), ','.join(map(str, tokens)), "4", "2", "8192"], env={**os.environ, 'STELLAN_RUNTIME_KV_Q8': '1'}, capture_output=True, text=True, encoding="utf-8", timeout=15, check=True)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(events[-1]['cache_type'], 'q8_0')
        self.assertLess(events[-1]['state_bytes'], events[-1]['state_capacity_bytes'])
        for event in [e for e in events if e['event'] == 'token']:
            self.assertEqual(event['id'], max(range(len(logits)), key=lambda i: logits[i]))
            for item in event['top']: self.assertAlmostEqual(item['logit'], logits[item['id']], delta=0.0001)
            logits = fixture.step(event['id'])

    def test_transformer_logits_survive_cache_chunk_growth(self):
        tokens = [1] + [68 + i % 20 for i in range(258)]
        for quantized in (False, True):
            with self.subTest(quantized=quantized):
                fixture = Fixture("llama"); fixture.quantized_cache = quantized
                data = fixture.bytes(); self.file.write_bytes(data)
                for token in tokens:
                    logits = fixture.step(token)
                result = subprocess.run([EXECUTABLE, "decode", str(self.file), hashlib.sha256(data).hexdigest(), ','.join(map(str, tokens)), "2", "2", "300"], env={**os.environ, 'STELLAN_RUNTIME_KV_Q8': '1' if quantized else ''}, capture_output=True, text=True, encoding="utf-8", timeout=15, check=True)
                for event in (json.loads(line) for line in result.stdout.splitlines()):
                    if event['event'] != 'token':
                        continue
                    self.assertEqual(event['id'], max(range(len(logits)), key=lambda i: logits[i]))
                    for item in event['top']:
                        self.assertAlmostEqual(item['logit'], logits[item['id']], delta=0.0001)
                    logits = fixture.step(event['id'])

    def test_hash_mismatch_blocks_execution(self):
        result = self.invoke(Fixture("mamba2").bytes(), "decode", "0" * 64, "1", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("hash mismatch", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_unimplemented_transformer_features_are_refused(self):
        fixture = Fixture("llama")
        fixture.metadata.append(("llama.attention.sliding_window", 4, struct.pack("<I", 32)))
        data = fixture.bytes()
        result = self.invoke(data, "decode", hashlib.sha256(data).hexdigest(), "1", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported transformer variant", result.stderr)

    def test_generation_cancellation(self):
        data = Fixture("mamba2").bytes()
        self.file.write_bytes(data)
        child = subprocess.Popen([EXECUTABLE, "decode", str(self.file), hashlib.sha256(data).hexdigest(), ",".join(["1"] * 1024), "4096"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child.stdout.readline()
        child.terminate()
        child.communicate(timeout=5)
        self.assertNotEqual(child.returncode, 0)


if __name__ == "__main__":
    unittest.main()
