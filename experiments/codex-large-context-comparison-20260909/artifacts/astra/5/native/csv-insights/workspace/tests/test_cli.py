import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CliTests(unittest.TestCase):
    def invoke(self, data, *args):
        # Keep test files inside the project, too.
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "input.csv"
            original = data.encode("utf-8") if isinstance(data, str) else data
            path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *args],
                capture_output=True,
            )
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, data, *args):
        result = self.invoke(data, *args)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b"")
        return json.loads(result.stdout)

    def failure(self, data, *args, contains):
        result = self.invoke(data, *args)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(contains, result.stderr.decode())
        self.assertEqual(result.stdout, b"")

    def test_quoted_fields_and_csv_roundtrip(self):
        data = 'name,note\r\n"Doe, Jane","first\r\nsecond ""quote"""\r\nZoë,ok\r\n'
        expected = [
            {"name": "Doe, Jane", "note": 'first\r\nsecond "quote"'},
            {"name": "Zoë", "note": "ok"},
        ]
        self.assertEqual(self.success(data), expected)
        result = self.invoke(data, "--output", "csv")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(list(csv.DictReader(io.StringIO(result.stdout.decode(), newline=""))), expected)
        self.assertIn(b"\r\n", result.stdout)

    def test_filters_are_exact_and_combined(self):
        data = 'a,b\nx,1\nx,2\nX,2\nx,2\n'
        self.assertEqual(self.success(data, "--where", "a=x", "--where", "b=2"),
                         [{"a": "x", "b": "2"}] * 2)

    def test_empty_and_equals_filter_values(self):
        self.assertEqual(self.success('a,b\n,x=y\nx,y\n', "--where", "a=", "--where", "b=x=y"),
                         [{"a": "", "b": "x=y"}])

    def test_sorted_sum_and_average(self):
        data = 'g,x,y\nz,0.1,1\na,1e-2,4\nz,0.2,2\na,-0.010,6\n'
        self.assertEqual(self.success(data, "--group-by", "g", "--sum", "x", "--avg", "y"), [
            {"g": "a", "sum_x": "0", "avg_y": "5"},
            {"g": "z", "sum_x": "0.3", "avg_y": "1.5"},
        ])

    def test_precision_and_cancellation(self):
        number = "1234567890123456789012345678901234567890"
        data = f'g,x\na,{number}\na,0.01\nb,{number}\nb,-{number}\n'
        self.assertEqual(self.success(data, "--group-by", "g", "--sum", "x"), [
            {"g": "a", "sum_x": number + ".01"}, {"g": "b", "sum_x": "0"},
        ])

    def test_repeating_average(self):
        rows = self.success('g,x\na,1\na,0\na,0\n', "--group-by", "g", "--avg", "x")
        self.assertEqual(rows, [{"g": "a", "avg_x": "0." + "3" * 28}])

    def test_same_column_both_aggregations(self):
        self.assertEqual(self.success('g,x\na,1\na,4\n', "--group-by", "g", "--sum", "x", "--avg", "x"),
                         [{"g": "a", "sum_x": "5", "avg_x": "2.5"}])

    def test_group_by_alone_preserves_rows(self):
        self.assertEqual(self.success('g\nz\na\nz\n', "--group-by", "g"),
                         [{"g": "z"}, {"g": "a"}, {"g": "z"}])

    def test_empty_results(self):
        self.assertEqual(self.success('g,x\n'), [])
        result = self.invoke('g,x\na,1\n', "--where", "g=b", "--group-by", "g", "--sum", "x", "--output", "csv")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'g,sum_x\r\n')

    def test_numeric_validation_after_filter(self):
        self.assertEqual(self.success('g,x\na,invalid\nb,2\n', "--where", "g=b", "--group-by", "g", "--sum", "x"),
                         [{"g": "b", "sum_x": "2"}])

    def test_bad_numbers_identify_record_and_column(self):
        for value in ["", " ", "oops", "NaN", "Infinity", "-Infinity", "sNaN"]:
            with self.subTest(value=value):
                self.failure(f'g,x\na,1\nb,{value}\n', "--group-by", "g", "--sum", "x", contains="row 3, column 'x'")

    def test_bad_headers(self):
        for data in ['', '\n', ',x\n', 'x,x\n']:
            with self.subTest(data=data):
                self.failure(data, contains="header")

    def test_wrong_width_even_when_filtered(self):
        for row in ['b', 'b,1,2', '']:
            with self.subTest(row=row):
                self.failure(f'g,x\na,1\n{row}\n', "--where", "g=a", contains="row 3")

    def test_malformed_csv(self):
        for data in ['a,b\n"unclosed,x\n', 'a,b\n"closed"junk,x\n']:
            with self.subTest(data=data):
                self.failure(data, contains="malformed CSV")

    def test_unknown_columns(self):
        for args in [("--where", "missing=x"), ("--group-by", "missing"),
                     ("--group-by", "g", "--sum", "missing"),
                     ("--group-by", "g", "--avg", "missing")]:
            with self.subTest(args=args):
                self.failure('g,x\n', *args, contains="unknown column")

    def test_invalid_arguments(self):
        for args, message in [(("--sum", "x"), "require --group-by"),
                              (("--avg", "x"), "require --group-by"),
                              (("--where", "x"), "malformed filter"),
                              (("--where", "=x"), "malformed filter"),
                              (("--output", "xml"), "invalid choice"),
                              (("--unknown",), "unrecognized arguments")]:
            with self.subTest(args=args):
                self.failure('g,x\n', *args, contains=message)

    def test_generated_header_collision(self):
        self.failure('sum_x,x\na,1\n', "--group-by", "sum_x", "--sum", "x", contains="conflicts")

    def test_bom_and_invalid_utf8(self):
        self.assertEqual(self.success('\ufeffa\nhello\n'), [{"a": "hello"}])
        self.failure(b'a\n\xff\n', contains="error:")

    def test_missing_input(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            result = subprocess.run([sys.executable, str(ROOT / 'main.py'), str(Path(directory) / 'missing.csv')], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'error:', result.stderr)
            self.assertEqual(result.stdout, b'')


if __name__ == "__main__":
    unittest.main()
