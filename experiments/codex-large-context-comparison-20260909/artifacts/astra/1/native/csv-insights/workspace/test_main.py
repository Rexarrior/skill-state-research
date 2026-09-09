"""End-to-end CLI tests; temporary files stay inside the project directory."""

import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


class CliTests(unittest.TestCase):
    def run_cli(self, content, *args):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *args],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, content, *args):
        result = self.run_cli(content, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout

    def test_quotes_newlines_and_order(self):
        content = 'name,note\r\nb,"hello, world"\r\na,"line 1\r\nline ""2"""\r\n'
        result = json.loads(self.success(content))
        self.assertEqual(result, [
            {"name": "b", "note": "hello, world"},
            {"name": "a", "note": 'line 1\r\nline "2"'},
        ])
        output = self.success(content, "--output", "csv")
        self.assertEqual(list(csv.reader(io.StringIO(output))), [
            ["name", "note"], ["b", "hello, world"], ["a", 'line 1\nline "2"'],
        ])

    def test_filters(self):
        content = "x,y,z\na,b=c,\na,b=c,no\nA,b=c,\na,b,\n"
        output = self.success(content, "--where", "x=a", "--where", "y=b=c", "--where", "z=")
        self.assertEqual(json.loads(output), [{"x": "a", "y": "b=c", "z": ""}])

    def test_aggregates(self):
        content = "g,x,y\nz,0.1,1\na,1e-2,4\nz,0.2,2\n"
        output = self.success(content, "--group-by", "g", "--sum", "x", "--avg", "y")
        self.assertEqual(json.loads(output), [
            {"g": "a", "sum_x": "0.01", "avg_y": "4"},
            {"g": "z", "sum_x": "0.3", "avg_y": "1.5"},
        ])

    def test_same_column_and_large_exact_sum(self):
        number = "123456789012345678901234567890"
        output = self.success(f"g,x\na,{number}\na,0.1\n", "--group-by", "g", "--sum", "x", "--avg", "x")
        row = json.loads(output)[0]
        self.assertEqual(row["sum_x"], number + ".1")
        self.assertEqual(row["avg_x"], "61728394506172839450617283945.05")

    def test_group_only(self):
        self.assertEqual(json.loads(self.success("g\nz\na\nz\n", "--group-by", "g")), [{"g": "a"}, {"g": "z"}])

    def test_empty_results_and_bom(self):
        self.assertEqual(json.loads(self.success("\ufeffg,x\n")), [])
        self.assertEqual(self.success("g,x\n", "--group-by", "g", "--sum", "x", "--output", "csv"), "g,sum_x\n")

    def test_filtered_numeric_errors_are_excluded(self):
        self.assertEqual(json.loads(self.success("g,x\na,bad\nb,2\n", "--where", "g=b", "--group-by", "g", "--sum", "x")), [{"g": "b", "sum_x": "2"}])

    def test_numeric_errors(self):
        for value in ("", "bad", "NaN", "Infinity", "-Infinity"):
            with self.subTest(value=value):
                result = self.run_cli(f"g,x\na,{value}\n", "--group-by", "g", "--avg", "x")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'x'", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_bad_input(self):
        for content, message in [
            ("", "headers"), ("x,\n", "non-empty"), ("x,x\n", "unique"),
            ("x,y\n1\n", "row 2"), ("x\n1,2\n", "row 2"),
            ('x\n"unfinished', "malformed CSV"), ("x\n\n", "row 2"),
        ]:
            with self.subTest(content=content):
                result = self.run_cli(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_invalid_arguments(self):
        for args in [
            ("--sum", "x"), ("--avg", "x"), ("--where", "bad"),
            ("--where", "=value"), ("--where", "missing=a"),
            ("--group-by", "missing"), ("--group-by", "x", "--sum", "missing"),
            ("--output", "xml"), ("--unknown",), ("--where",),
        ]:
            with self.subTest(args=args):
                result = self.run_cli("x\n1\n", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
