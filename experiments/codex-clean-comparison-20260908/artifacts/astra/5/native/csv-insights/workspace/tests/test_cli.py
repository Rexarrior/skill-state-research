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
    def run_cli(self, content, *arguments, success=True):
        # Keep all test files inside the project directory.
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *arguments],
                capture_output=True, text=True, encoding="utf-8",
            )
            self.assertEqual(path.read_bytes(), original)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("Traceback", result.stderr)
        return result

    def test_quoted_fields_and_input_order(self):
        result = self.run_cli('id,text\r\n2,"hello, world"\r\n1,"two\nlines and ""quotes"""\r\n')
        self.assertEqual(json.loads(result.stdout), [
            {"id": "2", "text": "hello, world"},
            {"id": "1", "text": 'two\nlines and "quotes"'},
        ])

    def test_filters_are_exact_and_combined(self):
        content = "a,b,c\nx,yes,1\nx,no,2\nX,yes,3\nx,yes,4\n"
        result = self.run_cli(content, "--where", "a=x", "--where", "b=yes")
        self.assertEqual([r["c"] for r in json.loads(result.stdout)], ["1", "4"])

    def test_empty_filter_and_equals_in_value(self):
        result = self.run_cli("a,b\n,x=y\nq,x=y\n", "--where", "a=", "--where", "b=x=y")
        self.assertEqual(json.loads(result.stdout), [{"a": "", "b": "x=y"}])

    def test_aggregates_sorted_and_minimal(self):
        result = self.run_cli("g,x,y\nz,0.10,1\na,1.5,2\nz,0.20,4\na,1.5,3\n",
                              "--group-by", "g", "--sum", "x", "--avg", "y")
        self.assertEqual(json.loads(result.stdout), [
            {"g": "a", "sum_x": "3", "avg_y": "2.5"},
            {"g": "z", "sum_x": "0.3", "avg_y": "2.5"},
        ])

    def test_sum_and_avg_same_column(self):
        result = self.run_cli("g,x\na,1e-2\na,0.03\n", "--group-by", "g", "--sum", "x", "--avg", "x")
        self.assertEqual(json.loads(result.stdout), [{"g": "a", "sum_x": "0.04", "avg_x": "0.02"}])

    def test_large_exact_sum_and_cancellation(self):
        huge = "10000000000000000000000000000000000000000"
        result = self.run_cli(f"g,x\na,{huge}\na,0.01\nb,-0.00\nc,{huge}\nc,0.01\nc,-{huge}\n",
                              "--group-by", "g", "--sum", "x")
        self.assertEqual(json.loads(result.stdout), [
            {"g": "a", "sum_x": huge + ".01"},
            {"g": "b", "sum_x": "0"},
            {"g": "c", "sum_x": "0.01"},
        ])

    def test_repeating_average(self):
        result = self.run_cli("g,x\na,1\na,0\na,0\n", "--group-by", "g", "--avg", "x")
        self.assertEqual(json.loads(result.stdout)[0]["avg_x"], "0." + "3" * 28)

    def test_group_only(self):
        result = self.run_cli("g,x\nz,1\na,2\nz,3\n", "--group-by", "g")
        self.assertEqual(json.loads(result.stdout), [{"g": "a"}, {"g": "z"}])

    def test_csv_round_trip(self):
        content = 'id,text\r\n1,"comma, quote "" and\nnewline"\r\n'
        result = self.run_cli(content, "--output", "csv")
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(content))))

    def test_aggregate_csv(self):
        result = self.run_cli('g,x\n"a,b",2\n"a,b",3\n', "--group-by", "g", "--sum", "x", "--output", "csv")
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [["g", "sum_x"], ["a,b", "5"]])

    def test_empty_results_and_header_only(self):
        self.assertEqual(json.loads(self.run_cli("a,b\n").stdout), [])
        result = self.run_cli("a,b\nx,1\n", "--where", "a=y", "--output", "csv")
        self.assertEqual(result.stdout, "a,b\n")
        result = self.run_cli("a,b\n", "--group-by", "a", "--avg", "b", "--output", "csv")
        self.assertEqual(result.stdout, "a,avg_b\n")

    def test_bom_and_unicode(self):
        result = self.run_cli("\ufeffname\n你好\n")
        self.assertEqual(json.loads(result.stdout), [{"name": "你好"}])

    def test_invalid_headers(self):
        for content in ("", "\n", ",b\n", "a,a\n"):
            with self.subTest(content=content):
                self.assertIn("header", self.run_cli(content, success=False).stderr)

    def test_wrong_width_even_if_filtered_out(self):
        for record in ("x", "x,1,2", ""):
            with self.subTest(record=record):
                result = self.run_cli("a,b\n" + record + "\n", "--where", "a=other", success=False)
                self.assertIn("row 2", result.stderr)
                self.assertIn("fields", result.stderr)

    def test_malformed_csv(self):
        for content in ('a,b\n1,"unfinished\n', 'a,b\n1,"quoted"junk\n'):
            with self.subTest(content=content):
                self.assertIn("malformed CSV", self.run_cli(content, success=False).stderr)

    def test_bad_numeric_cells(self):
        for value in ("", " ", "nope", "NaN", "sNaN", "Infinity", "-Infinity"):
            with self.subTest(value=value):
                result = self.run_cli(f"g,x\na,{value}\n", "--group-by", "g", "--sum", "x", success=False)
                self.assertIn("row 2", result.stderr)
                self.assertIn("column 'x'", result.stderr)

    def test_numeric_validation_after_filter(self):
        result = self.run_cli("g,x\na,nope\nb,2\n", "--where", "g=b", "--group-by", "g", "--avg", "x")
        self.assertEqual(json.loads(result.stdout), [{"g": "b", "avg_x": "2"}])

    def test_invalid_arguments(self):
        for arguments in (("--sum", "b"), ("--avg", "b"), ("--where", "a"),
                          ("--where", "=x"), ("--where", "missing=x"),
                          ("--group-by", "missing"), ("--group-by", "a", "--sum", "missing"),
                          ("--group-by", "a", "--avg", "missing"), ("--output", "xml"),
                          ("--unknown",), ("--sum",)):
            with self.subTest(arguments=arguments):
                self.run_cli("a,b\n", *arguments, success=False)

    def test_output_name_collision(self):
        result = self.run_cli("sum_x,x\n", "--group-by", "sum_x", "--sum", "x", success=False)
        self.assertIn("conflicts", result.stderr)

    def test_missing_file(self):
        result = subprocess.run([sys.executable, str(ROOT / "main.py"), str(ROOT / "nonexistent.csv")], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
