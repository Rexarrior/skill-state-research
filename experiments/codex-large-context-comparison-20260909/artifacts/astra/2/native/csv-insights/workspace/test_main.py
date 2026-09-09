"""End-to-end tests using only the standard library."""

import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


class CLITests(unittest.TestCase):
    def run_cli(self, content, *arguments):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            source = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            source.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
            )
            self.assertEqual(source.read_bytes(), original)
            return result

    def success(self, content, *arguments):
        result = self.run_cli(content, *arguments)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout

    def failure(self, content, *arguments, contains):
        result = self.run_cli(content, *arguments)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(contains, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_rfc_csv_and_order(self):
        content = 'name,note\r\n"Doe, Jane","one\r\ntwo"\r\nBob,"says ""hi"""\r\n'
        result = json.loads(self.success(content))
        self.assertEqual(result, [
            {"name": "Doe, Jane", "note": "one\r\ntwo"},
            {"name": "Bob", "note": 'says "hi"'},
        ])
        output = self.success(content, "--output", "csv")
        self.assertEqual(list(csv.reader(io.StringIO(output))), [
            ["name", "note"], ["Doe, Jane", "one\ntwo"], ["Bob", 'says "hi"'],
        ])

    def test_exact_and_filters(self):
        content = "a,b\nX,=yes\nX,\nx,=yes\nX,=yes\n"
        self.assertEqual(json.loads(self.success(content, "--where", "a=X", "--where", "b==yes")),
                         [{"a": "X", "b": "=yes"}] * 2)
        self.assertEqual(json.loads(self.success(content, "--where", "b=")), [{"a": "X", "b": ""}])
        self.assertEqual(json.loads(self.success(content, "--where", "a=X", "--where", "a=x")), [])

    def test_aggregations_sorted_and_minimal(self):
        content = "g,x,y\nz,0.10,2\na,1e-2,3\nz,0.20,3\na,-0.010,4\n"
        self.assertEqual(json.loads(self.success(content, "--group-by", "g", "--sum", "x", "--avg", "y")), [
            {"g": "a", "sum_x": "0", "avg_y": "3.5"},
            {"g": "z", "sum_x": "0.3", "avg_y": "2.5"},
        ])

    def test_same_column_sum_and_avg(self):
        output = self.success("g,x\nb,1\nb,2\n", "--group-by", "g", "--sum", "x", "--avg", "x", "--output", "csv")
        self.assertEqual(output, "g,sum_x,avg_x\nb,3,1.5\n")

    def test_large_exact_sum(self):
        content = "g,x\na,123456789012345678901234567890.01\na,0.02\n"
        result = json.loads(self.success(content, "--group-by", "g", "--sum", "x"))
        self.assertEqual(result[0]["sum_x"], "123456789012345678901234567890.03")

    def test_repeating_average(self):
        result = json.loads(self.success("g,x\na,1\na,0\na,0\n", "--group-by", "g", "--avg", "x"))
        self.assertEqual(result, [{"g": "a", "avg_x": "0." + "3" * 28}])

    def test_group_by_without_aggregation(self):
        self.assertEqual(json.loads(self.success("g,x\nz,2\na,1\nz,3\n", "--group-by", "g")),
                         [{"g": "z", "x": "2"}, {"g": "a", "x": "1"}, {"g": "z", "x": "3"}])

    def test_empty_results(self):
        self.assertEqual(self.success("g,x\n", "--output", "csv"), "g,x\n")
        self.assertEqual(json.loads(self.success("g,x\n", "--group-by", "g", "--avg", "x")), [])
        self.assertEqual(self.success("g,x\na,1\n", "--where", "g=b", "--group-by", "g", "--sum", "x", "--output", "csv"), "g,sum_x\n")

    def test_unicode_and_bom(self):
        self.assertEqual(json.loads(self.success("\ufeffcity,x\nМосква,1\n")), [{"city": "Москва", "x": "1"}])

    def test_invalid_headers(self):
        for content, message in [("", "headers"), ("\n", "headers"), ("a,\n", "non-empty"), ("a,a\n", "unique")]:
            with self.subTest(content=content):
                self.failure(content, contains=message)

    def test_wrong_field_counts_even_if_filtered(self):
        for row in ["b", "b,2,3", ""]:
            with self.subTest(row=row):
                self.failure("g,x\na,1\n" + row + "\n", "--where", "g=a", contains="row 3")

    def test_malformed_quoting(self):
        for content in ['a,b\n1,"unterminated\n', 'a,b\n1,"hello"oops\n']:
            with self.subTest(content=content):
                self.failure(content, contains="error:")

    def test_invalid_numbers_report_row_and_column(self):
        for cell in ["", " ", "abc", "NaN", "Infinity", "-inf", "1_000"]:
            with self.subTest(cell=cell):
                self.failure("g,x\na,1\na," + cell + "\n", "--group-by", "g", "--sum", "x", contains="row 3, column 'x'")

    def test_invalid_filtered_number_is_ignored(self):
        self.assertEqual(json.loads(self.success("g,x\na,2\nb,invalid\n", "--where", "g=a", "--group-by", "g", "--avg", "x")),
                         [{"g": "a", "avg_x": "2"}])

    def test_unknown_columns(self):
        for arguments in [("--where", "missing=x"), ("--group-by", "missing"),
                          ("--group-by", "g", "--sum", "missing"), ("--group-by", "g", "--avg", "missing")]:
            with self.subTest(arguments=arguments):
                self.failure("g,x\n", *arguments, contains="unknown column 'missing'")

    def test_invalid_arguments(self):
        for arguments, message in [(("--sum", "x"), "require --group-by"),
                                   (("--avg", "x"), "require --group-by"),
                                   (("--where", "x"), "malformed filter"),
                                   (("--where", "=value"), "malformed filter"),
                                   (("--output", "xml"), "invalid choice"),
                                   (("--unknown",), "unrecognized arguments"),
                                   (("--where",), "expected one argument")]:
            with self.subTest(arguments=arguments):
                self.failure("g,x\n", *arguments, contains=message)

    def test_output_name_collision(self):
        self.failure("sum_x,x\na,1\n", "--group-by", "sum_x", "--sum", "x", contains="output column names")

    def test_missing_file(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            result = subprocess.run([sys.executable, str(ROOT / "main.py"), str(Path(directory) / "missing.csv")], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("error:", result.stderr)
            self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
