import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CLITests(unittest.TestCase):
    def run_cli(self, contents, *args):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "input.csv"
            original = contents.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(ROOT / "main.py"), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, contents, *args):
        result = self.run_cli(contents, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout

    def test_quoted_fields_and_newlines(self):
        data = 'name,note\r\n"Doe, Jo","hello\n""world"""\r\n'
        expected = [{"name": "Doe, Jo", "note": 'hello\n"world"'}]
        self.assertEqual(json.loads(self.success(data)), expected)
        output = self.success(data, "--output", "csv")
        self.assertEqual(list(csv.DictReader(io.StringIO(output))), expected)

    def test_filters(self):
        data = "a,b\nx,\nx,a=b\ny,a=b\nx,a=b\n"
        self.assertEqual(json.loads(self.success(data, "--where", "a=x", "--where", "b=a=b")),
                         [{"a": "x", "b": "a=b"}] * 2)
        self.assertEqual(json.loads(self.success(data, "--where", "b=")), [{"a": "x", "b": ""}])

    def test_aggregations(self):
        data = "g,x,y\nb,0.1,1\na,2.500,3\nb,0.2,2\n"
        self.assertEqual(json.loads(self.success(data, "--group-by", "g", "--sum", "x", "--avg", "y")),
                         [{"g": "a", "sum_x": "2.5", "avg_y": "3"},
                          {"g": "b", "sum_x": "0.3", "avg_y": "1.5"}])
        self.assertEqual(json.loads(self.success(data, "--group-by", "g")), [{"g": "a"}, {"g": "b"}])

    def test_precision_and_format(self):
        data = "g,n\nx,123456789012345678901234567890\nx,0.01\n"
        self.assertEqual(json.loads(self.success(data, "--group-by", "g", "--sum", "n"))[0]["sum_n"],
                         "123456789012345678901234567890.01")
        for numbers, expected in [("1e-2", "0.01"), ("-0.00", "0"), ("3.000", "3"), ("1e2", "100")]:
            self.assertEqual(json.loads(self.success(f"g,n\nx,{numbers}\n", "--group-by", "g", "--sum", "n"))[0]["sum_n"], expected)

    def test_empty_results_and_bom(self):
        self.assertEqual(json.loads(self.success("\ufeffa,b\n")), [])
        self.assertEqual(self.success("a,b\nx,y\n", "--where", "a=z", "--output", "csv"), "a,b\n")
        self.assertEqual(self.success("g,n\n", "--group-by", "g", "--sum", "n", "--output", "csv"), "g,sum_n\n")

    def test_average_precision_and_shared_column(self):
        output = self.success("g,n\nx,100000000000000000000000000001\nx,0\n",
                              "--group-by", "g", "--sum", "n", "--avg", "n")
        self.assertEqual(json.loads(output), [{"g": "x", "sum_n": "100000000000000000000000000001",
                                              "avg_n": "50000000000000000000000000000.5"}])
        output = self.success("g,n\nx,1\nx,0\nx,0\n", "--group-by", "g", "--avg", "n")
        self.assertEqual(json.loads(output)[0]["avg_n"], "0.3333333333333333333333333333")

    def test_missing_file(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            result = subprocess.run([sys.executable, str(ROOT / "main.py"), str(Path(directory) / "missing.csv")],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("error:", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_bad_inputs(self):
        for data, message in [("", "headers"), ("a,\n", "headers"), ("a,a\n", "unique"),
                              ("a,b\nx\n", "row 2"), ("a\nx,y\n", "row 2"),
                              ('a\n"unterminated', "malformed CSV"), ('a\n"x"garbage\n', "malformed CSV")]:
            with self.subTest(data=data):
                result = self.run_cli(data)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_bad_queries(self):
        for args in [("--where", "a"), ("--where", "=x"), ("--where", "missing=x"),
                     ("--group-by", "missing"), ("--sum", "a"), ("--avg", "a"),
                     ("--group-by", "a", "--sum", "missing"), ("--output", "xml"), ("--unknown",)]:
            with self.subTest(args=args):
                result = self.run_cli("a\nx\n", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)

    def test_bad_numbers(self):
        for value in ("", " ", "no", "NaN", "Infinity", "-Infinity"):
            with self.subTest(value=value):
                result = self.run_cli(f"g,n\nx,{value}\n", "--group-by", "g", "--avg", "n")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2", result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_filtered_validation(self):
        self.assertEqual(json.loads(self.success("g,n\nx,bad\ny,2\n", "--where", "g=y",
                                               "--group-by", "g", "--sum", "n")), [{"g": "y", "sum_n": "2"}])
        result = self.run_cli("g,n\nx\n", "--where", "g=y")
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
