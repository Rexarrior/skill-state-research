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
    def run_cli(self, content, *arguments, success=True):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *arguments],
                capture_output=True, text=True,
            )
            self.assertEqual(path.read_bytes(), original)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, "")
        return result

    def test_rfc_csv_round_trip(self):
        data = 'name,note\r\n"Doe, Jane","hello\r\n""world"""\r\nAlice,\r\n'
        result = self.run_cli(data)
        self.assertEqual(json.loads(result.stdout), [
            {"name": "Doe, Jane", "note": 'hello\r\n"world"'},
            {"name": "Alice", "note": ""},
        ])
        output = self.run_cli(data, "--output", "csv").stdout
        self.assertEqual(list(csv.reader(io.StringIO(output))), [
            ["name", "note"], ["Doe, Jane", 'hello\n"world"'], ["Alice", ""],
        ])

    def test_filters_are_exact_and_combined(self):
        data = 'k,v,n\nx,a=b,1\nx,a=b,2\ny,a=b,3\nx,A=b,4\nx,,5\n'
        result = self.run_cli(data, "--where", "k=x", "--where", "v=a=b")
        self.assertEqual([r["n"] for r in json.loads(result.stdout)], ["1", "2"])
        result = self.run_cli(data, "--where", "v=")
        self.assertEqual(json.loads(result.stdout)[0]["n"], "5")

    def test_group_aggregates(self):
        data = 'g,x,y\nb,0.1,1\na,1e-2,5\nb,0.2,2\na,-0.01,6\n'
        result = self.run_cli(data, "--group-by", "g", "--sum", "x", "--avg", "y")
        self.assertEqual(json.loads(result.stdout), [
            {"g": "a", "sum_x": "0", "avg_y": "5.5"},
            {"g": "b", "sum_x": "0.3", "avg_y": "1.5"},
        ])
        result = self.run_cli(data, "--group-by", "g", "--sum", "x", "--avg", "x")
        self.assertEqual(json.loads(result.stdout)[1]["avg_x"], "0.15")
        result = self.run_cli(data, "--group-by", "g")
        self.assertEqual(json.loads(result.stdout), json.loads(self.run_cli(data).stdout))

    def test_aggregate_csv_and_repeating_average(self):
        data = 'g,x\n"a,b",1\n"a,b",0\n"a,b",0\n'
        result = self.run_cli(data, "--group-by", "g", "--sum", "x", "--avg", "x",
                              "--output", "csv")
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [
            ["g", "sum_x", "avg_x"], ["a,b", "1", "0.3333333333333333333333333333"],
        ])

    def test_large_exact_sum(self):
        data = 'g,x\na,123456789012345678901234567890\na,0.01\n'
        result = self.run_cli(data, "--group-by", "g", "--sum", "x")
        self.assertEqual(json.loads(result.stdout)[0]["sum_x"],
                         "123456789012345678901234567890.01")

    def test_empty_results(self):
        self.assertEqual(json.loads(self.run_cli("a,b\n").stdout), [])
        self.assertEqual(self.run_cli("a,b\n", "--output", "csv").stdout, "a,b\n")
        result = self.run_cli("a,b\nx,1\n", "--where", "a=y",
                              "--group-by", "a", "--avg", "b", "--output", "csv")
        self.assertEqual(result.stdout, "a,avg_b\n")

    def test_invalid_input(self):
        for data in ("", "a,\n", "a,a\n", "a,b\n1\n", "a,b\n1,2,3\n",
                     'a,b\n1,"unfinished', 'a,b\n1,"value"oops\n', "a,b\n\n"):
            with self.subTest(data=data):
                self.run_cli(data, success=False)

    def test_numeric_errors(self):
        for value in ("", " ", "nope", "NaN", "Infinity", "-Infinity"):
            with self.subTest(value=value):
                result = self.run_cli(f"g,x\na,{value}\n", "--group-by", "g",
                                      "--sum", "x", success=False)
                self.assertIn("row 2", result.stderr)
                self.assertIn("column 'x'", result.stderr)

    def test_invalid_arguments(self):
        for arguments in (("--sum", "x"), ("--avg", "x"), ("--where", "x"),
                          ("--where", "=v"), ("--where", "missing=v"),
                          ("--group-by", "missing"), ("--output", "xml"),
                          ("--unknown",), ("--where",),
                          ("--group-by", "g", "--sum", "missing")):
            with self.subTest(arguments=arguments):
                self.run_cli("g,x\na,1\n", *arguments, success=False)

    def test_filtered_row_validation(self):
        self.run_cli("g,x\na,bad\nb,2\n", "--where", "g=b", "--group-by", "g",
                     "--sum", "x")
        self.run_cli("g,x\na\nb,2\n", "--where", "g=b", success=False)

    def test_bom_and_unicode(self):
        result = self.run_cli("\ufeffg,x\n東京,1\n")
        self.assertEqual(json.loads(result.stdout), [{"g": "東京", "x": "1"}])


if __name__ == "__main__":
    unittest.main()
