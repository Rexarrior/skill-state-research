import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def run_cli(self, text, *args):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "input.csv"
            original = text.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("main.py")), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_quoted_csv_roundtrip(self):
        text = 'name,note\r\n"A,B","line 1\r\nline ""2"""\r\n'
        result = self.run_cli(text, "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        # subprocess text mode normalizes CRLF, including embedded newlines.
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [["name", "note"], ["A,B", 'line 1\nline "2"']])
        self.assertEqual(self.success(text)[0]["note"], 'line 1\r\nline "2"')

    def test_filters_and_order(self):
        text = "a,b,c\nx,yes,1\ny,yes,2\nx,no,3\nx,yes,4\n"
        self.assertEqual(self.success(text, "--where", "a=x", "--where", "b=yes"), [{"a": "x", "b": "yes", "c": "1"}, {"a": "x", "b": "yes", "c": "4"}])
        self.assertEqual(len(self.success("a,b\nx,\nx,a=b\n", "--where", "b=")), 1)
        self.assertEqual(len(self.success("a,b\nx,\nx,a=b\n", "--where", "b=a=b")), 1)

    def test_aggregates(self):
        text = "g,x,y\nb,0.1,1\na,2.50,3\nb,0.2,2\na,-0.50,2\n"
        self.assertEqual(self.success(text, "--group-by", "g", "--sum", "x", "--avg", "y"), [{"g": "a", "sum_x": "2", "avg_y": "2.5"}, {"g": "b", "sum_x": "0.3", "avg_y": "1.5"}])
        self.assertEqual(self.success(text, "--group-by", "g"), [{"g": "a"}, {"g": "b"}])

    def test_decimal_precision(self):
        text = "g,n\na,10000000000000000000000000000\na,0.01\n"
        self.assertEqual(self.success(text, "--group-by", "g", "--sum", "n")[0]["sum_n"], "10000000000000000000000000000.01")
        self.assertEqual(self.success("g,n\na,1e-2\na,-0.01\n", "--group-by", "g", "--sum", "n")[0]["sum_n"], "0")
        self.assertEqual(self.success("g,n\na,1\na,0\na,0\n", "--group-by", "g", "--avg", "n")[0]["avg_n"], "0.3333333333333333333333333333")

    def test_empty_results(self):
        self.assertEqual(self.success("a,b\n"), [])
        self.assertEqual(self.success("a,b\nx,1\n", "--where", "a=y", "--group-by", "a", "--sum", "b"), [])
        result = self.run_cli("a,b\n", "--output", "csv")
        self.assertEqual(result.stdout, "a,b\n")

    def test_invalid_inputs(self):
        for text, expected in [("", "headers"), ("a,\n", "non-empty"), ("a,a\n", "unique"), ("a,b\nx\n", "row 2"), ("a\nx,y\n", "row 2"), ('a\n"unterminated', "malformed CSV"), ('a\n"x"junk\n', "malformed CSV")]:
            with self.subTest(text=text):
                result = self.run_cli(text)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_numeric_errors(self):
        for value in ("", "abc", "NaN", "Infinity", "-Infinity", " "):
            with self.subTest(value=value):
                result = self.run_cli(f"g,n\na,{value}\n", "--group-by", "g", "--sum", "n")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2", result.stderr)
                self.assertIn("column 'n'", result.stderr)
        self.assertEqual(self.success("g,n\na,bad\nb,1\n", "--where", "g=b", "--group-by", "g", "--sum", "n"), [{"g": "b", "sum_n": "1"}])

    def test_invalid_arguments(self):
        for args in [("--where", "a"), ("--where", "=x"), ("--where", "z=x"), ("--group-by", "z"), ("--sum", "a"), ("--avg", "a"), ("--output", "yaml"), ("--unknown",), ("--group-by", "a", "--sum", "z")]:
            with self.subTest(args=args):
                result = self.run_cli("a,b\nx,1\n", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
