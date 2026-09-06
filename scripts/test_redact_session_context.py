import json
import unittest

from redact_session_context import Redactor, marker


class RedactionTests(unittest.TestCase):
    def setUp(self):
        self.redactor = Redactor([], ["PRIVATE_PROFILE"])

    def test_unicode_character_count_and_idempotence(self):
        source = "PRIVATE_PROFILE: правило 🐈"
        cleaned = self.redactor.string(source)
        self.assertEqual(cleaned, marker(source))
        self.assertEqual(self.redactor.string(cleaned), cleaned)

    def test_bounded_block_preserves_surrounding_task(self):
        block = "<!-- private-core:start -->closed rules<!-- private-core:end -->"
        self.assertEqual(self.redactor.string("before " + block + " after"),
                         "before " + marker(block) + " after")

    def test_linked_output_without_profile_name(self):
        records = [
            {"payload": {"type": "function_call", "name": "bash", "call_id": "x",
                         "arguments": '{"cmd":"cat PRIVATE_PROFILE"}'}},
            {"payload": {"type": "function_call_output", "call_id": "x", "output": "closed text"}},
            {"usage": {"input": 1200, "cached": 900, "output": 300}},
        ]
        raw = ("\n".join(map(json.dumps, records)) + "\n").encode()
        clean = self.redactor.clean(raw, "experiments/results/test.jsonl")
        parsed = [json.loads(line) for line in clean.splitlines()]
        self.assertEqual(parsed[1]["payload"]["output"], marker("closed text"))
        self.assertEqual(parsed[2], records[2])
        self.assertEqual(self.redactor.clean(clean, "experiments/results/test.jsonl"), clean)

    def test_serialized_output_preserves_numeric_measurements(self):
        value = {"call_id": "a", "output": json.dumps({
            "usage": {"input": 31}, "output": "closed text", "state": {"revision": 2}})}
        result = json.loads(self.redactor.walk(value, {"a"})["output"])
        self.assertEqual(result["usage"]["input"], 31)
        self.assertEqual(result["state"]["revision"], 2)
        self.assertEqual(result["output"], marker("closed text"))

    def test_open_code_output_without_profile_name(self):
        value = {"part": {"type": "tool", "state": {
            "input": {"command": "cat PRIVATE_PROFILE"}, "output": "closed text", "time": {"end": 20}}}}
        result = self.redactor.walk(value)
        self.assertEqual(result["part"]["state"]["output"], marker("closed text"))
        self.assertEqual(result["part"]["state"]["time"]["end"], 20)

    def test_preserves_unrelated_runtime_code_and_text(self):
        self.assertEqual(self.redactor.string("Implement a CSV parser"), "Implement a CSV parser")
        raw = b"// PRIVATE_PROFILE is a synthetic test fixture\n"
        self.assertEqual(self.redactor.clean(raw, "codex/core/example.rs"), raw)


if __name__ == "__main__":
    unittest.main()
