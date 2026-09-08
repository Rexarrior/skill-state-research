import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from decimal import Decimal
from main import exact_add


class CLITests(unittest.TestCase):
    def run_cli(self, data, *arguments):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            source = Path(directory) / "input.csv"
            original = data.encode("utf-8")
            source.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("main.py")), str(source), *arguments],
                capture_output=True, text=True,
            )
            self.assertEqual(source.read_bytes(), original)
            return result

    def successful(self, data, *arguments):
        result = self.run_cli(data, *arguments)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_rfc_csv_and_order(self):
        data = 'name,note\r\n"Doe, Jane","first\r\nsecond"\r\nBob,"say ""hi"""\r\n'
        rows = json.loads(self.successful(data))
        self.assertEqual(rows, [{"name": "Doe, Jane", "note": "first\r\nsecond"},
                                {"name": "Bob", "note": 'say "hi"'}])
        output = self.successful(data, "--output", "csv")
        self.assertEqual(list(csv.reader(io.StringIO(output))),
                         [["name", "note"], ["Doe, Jane", "first\nsecond"], ["Bob", 'say "hi"']])

    def test_filters_and_empty_value(self):
        data = 'a,b\nx,1\nx,2\ny,2\nx,\nx,a=b\n'
        self.assertEqual(json.loads(self.successful(data, "--where", "a=x", "--where", "b=2")),
                         [{"a": "x", "b": "2"}])
        self.assertEqual(json.loads(self.successful(data, "--where", "b=")), [{"a": "x", "b": ""}])
        self.assertEqual(json.loads(self.successful(data, "--where", "b=a=b")), [{"a": "x", "b": "a=b"}])

    def test_aggregates(self):
        data = 'g,n,m\nz,0.1,2\na,1e-2,3\nz,0.2,5\na,-0.00,5\n'
        self.assertEqual(json.loads(self.successful(data, "--group-by", "g", "--sum", "n", "--avg", "m")),
                         [{"g": "a", "sum_n": "0.01", "avg_m": "4"},
                          {"g": "z", "sum_n": "0.3", "avg_m": "3.5"}])
        self.assertEqual(json.loads(self.successful(data, "--group-by", "g")), [{"g": "a"}, {"g": "z"}])

    def test_large_exact_sum_and_repeating_average(self):
        data = 'g,n\na,123456789012345678901234567890\na,0.01\n'
        self.assertEqual(json.loads(self.successful(data, "--group-by", "g", "--sum", "n"))[0]["sum_n"],
                         "123456789012345678901234567890.01")
        data = 'g,n\na,1\na,0\na,0\n'
        self.assertEqual(json.loads(self.successful(data, "--group-by", "g", "--avg", "n"))[0]["avg_n"],
                         "0.3333333333333333333333333333")

    def test_empty_results(self):
        self.assertEqual(json.loads(self.successful('a,b\n')), [])
        self.assertEqual(self.successful('a,b\n', "--output", "csv"), "a,b\n")
        self.assertEqual(self.successful('a,b\n', "--group-by", "a", "--sum", "b", "--output", "csv"),
                         "a,sum_b\n")

    def test_errors(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'headers'),
                 ('a,b\n1\n', (), 'row 2'), ('a\n1,2\n', (), 'row 2'),
                 ('a\n"unfinished', (), 'malformed CSV'), ('a\n"x"junk\n', (), 'malformed CSV'),
                 ('a\n', ('--where', 'missing=x'), 'unknown column'),
                 ('a\n', ('--where', 'a'), 'malformed filter'),
                 ('a\n', ('--where', '=x'), 'malformed filter'),
                 ('a\n', ('--sum', 'a'), 'require --group-by'),
                 ('a\n', ('--avg', 'a'), 'require --group-by'),
                 ('a\n', ('--group-by', 'missing'), 'unknown column'),
                 ('a\n', ('--group-by', 'a', '--sum', 'missing'), 'unknown column'),
                 ('a\n', ('--output', 'xml'), 'invalid choice'),
                 ('a\n', ('--bogus',), 'unrecognized arguments')]
        for data, arguments, message in cases:
            with self.subTest(data=data, arguments=arguments):
                result = self.run_cli(data, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_numeric_validation(self):
        for value in ('', 'abc', 'NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'n'", result.stderr)
        self.assertEqual(json.loads(self.successful('g,n\na,bad\nb,2\n', '--where', 'g=b',
                                                   '--group-by', 'g', '--sum', 'n')),
                         [{"g": "b", "sum_n": "2"}])

    def test_excluded_rows_still_require_correct_width(self):
        result = self.run_cli('a,b\nx,1\ny\n', '--where', 'a=x')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('row 3', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_bom(self):
        self.assertEqual(json.loads(self.successful('\ufeffa\nx\n')), [{"a": "x"}])

    def test_extreme_decimal_exponent(self):
        self.assertEqual(exact_add(Decimal('1e-1000050'), Decimal('1e-1000050')),
                         Decimal('2e-1000050'))

    def test_missing_file(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name('main.py')), str(Path(directory) / 'absent.csv')],
                capture_output=True, text=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('error:', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_output_column_collision(self):
        result = self.run_cli('sum_n,n\na,1\n', '--group-by', 'sum_n', '--sum', 'n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('conflicts', result.stderr)


if __name__ == '__main__':
    unittest.main()
