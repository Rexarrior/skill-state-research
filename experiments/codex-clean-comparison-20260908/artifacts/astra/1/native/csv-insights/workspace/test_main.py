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
    def run_cli(self, content, *args, success=True):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(ROOT / "main.py"), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, "")
        return result

    def test_quoted_records_and_input_order(self):
        data = 'name,note\r\nZ,"a,b"\r\nA,"line 1\nline 2 ""quoted"""\r\n'
        result = self.run_cli(data)
        rows = json.loads(result.stdout)
        self.assertEqual(rows, [{"name": "Z", "note": "a,b"},
                                {"name": "A", "note": 'line 1\nline 2 "quoted"'}])
        output = self.run_cli(data, "--output", "csv").stdout
        self.assertEqual(list(csv.DictReader(io.StringIO(output))), rows)

    def test_filters(self):
        result = self.run_cli("a,b\nx,\nx,v=1\ny,v=1\nx,v=1\n", "--where", "a=x", "--where", "b=v=1")
        self.assertEqual(json.loads(result.stdout), [{"a": "x", "b": "v=1"}] * 2)
        self.assertEqual(json.loads(self.run_cli("a,b\nx,\n", "--where", "b=").stdout), [{"a": "x", "b": ""}])

    def test_aggregates(self):
        data = "g,x,y\nb,0.1,2\na,1.00,4\nb,0.2,3\na,2,6\n"
        result = self.run_cli(data, "--group-by", "g", "--sum", "x", "--avg", "y")
        self.assertEqual(json.loads(result.stdout), [
            {"g": "a", "sum_x": "3", "avg_y": "5"},
            {"g": "b", "sum_x": "0.3", "avg_y": "2.5"}])

    def test_exact_large_sum(self):
        result = self.run_cli("g,n\na,123456789012345678901234567890\na,0.01\n", "--group-by", "g", "--sum", "n")
        self.assertEqual(json.loads(result.stdout)[0]["sum_n"], "123456789012345678901234567890.01")

    def test_decimal_formats(self):
        for cells, expected in [("1e-2", "0.01"), ("-0.00", "0"), (" 2.500 ", "2.5")]:
            with self.subTest(cells=cells):
                result = self.run_cli(f"g,n\na,{cells}\n", "--group-by", "g", "--sum", "n", "--avg", "n")
                self.assertEqual(json.loads(result.stdout), [{"g": "a", "sum_n": expected, "avg_n": expected}])

    def test_repeating_average(self):
        result = self.run_cli("g,n\na,1\na,0\na,0\n", "--group-by", "g", "--avg", "n")
        self.assertEqual(json.loads(result.stdout)[0]["avg_n"], "0." + "3" * 28)

    def test_group_only_and_empty(self):
        self.assertEqual(json.loads(self.run_cli("g\nb\na\nb\n", "--group-by", "g").stdout), [{"g": "a"}, {"g": "b"}])
        self.assertEqual(json.loads(self.run_cli("g,n\n", "--group-by", "g", "--sum", "n").stdout), [])
        self.assertEqual(self.run_cli("g,n\na,1\n", "--where", "g=b", "--output", "csv").stdout, "g,n\n")

    def test_invalid_input(self):
        for data in ["", "\n", "a,\n", "a,a\n", "a,   \n", "a,b\n1\n", "a\n1,2\n", 'a\n"unterminated', 'a\n"x"junk\n']:
            with self.subTest(data=data):
                self.run_cli(data, success=False)

    def test_invalid_numeric_locations(self):
        for value in ["", "abc", "NaN", "Infinity", "1_000"]:
            with self.subTest(value=value):
                result = self.run_cli(f"g,n\na,{value}\n", "--group-by", "g", "--sum", "n", success=False)
                self.assertIn("row 2", result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_filtered_validation(self):
        self.run_cli("g,n\na,invalid\nb,1\n", "--where", "g=b", "--group-by", "g", "--sum", "n")
        self.run_cli("g,n\na,1,extra\n", "--where", "g=b", success=False)

    def test_invalid_arguments(self):
        for args in [("--sum", "n"), ("--avg", "n"), ("--where", "g"), ("--where", "=x"),
                     ("--where", "missing=x"), ("--group-by", "missing"),
                     ("--group-by", "g", "--sum", "missing"), ("--output", "xml"),
                     ("--unknown",), ("--where",), ("--gr", "g")]:
            with self.subTest(args=args):
                self.run_cli("g,n\n", *args, success=False)

    def test_bom(self):
        self.assertEqual(json.loads(self.run_cli("\ufeffa\nx\n").stdout), [{"a": "x"}])

    def test_output_column_collision(self):
        self.run_cli("sum_n,n\na,1\n", "--group-by", "sum_n", "--sum", "n", success=False)

    def test_missing_file(self):
        result = subprocess.run([sys.executable, str(ROOT / "main.py"), str(ROOT / "nonexistent.csv")], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error:", result.stderr)


if __name__ == "__main__":
    unittest.main()
