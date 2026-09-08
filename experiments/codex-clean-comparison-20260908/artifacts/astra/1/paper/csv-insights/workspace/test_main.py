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
            path = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_quoting_and_order(self):
        rows = self.success('name,note\r\n"Smith, Jane","line 1\nline ""2"""\r\nBob,ok\r\n')
        self.assertEqual(rows, [{'name': 'Smith, Jane', 'note': 'line 1\nline "2"'}, {'name': 'Bob', 'note': 'ok'}])

    def test_filters(self):
        self.assertEqual(self.success('a,b\nx,\nx,yes\ny,\n', '--where', 'a=x', '--where', 'b='), [{'a': 'x', 'b': ''}])
        self.assertEqual(self.success('a\nx=y\n', '--where', 'a=x=y'), [{'a': 'x=y'}])

    def test_aggregates(self):
        self.assertEqual(self.success('g,n,m\nz,0.1,1\na,2.50,2\nz,0.2,2\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm'),
                         [{'g': 'a', 'sum_n': '2.5', 'avg_m': '2'}, {'g': 'z', 'sum_n': '0.3', 'avg_m': '1.5'}])

    def test_precision(self):
        self.assertEqual(self.success('g,n\nx,123456789012345678901234567890\nx,0.01\n', '--group-by', 'g', '--sum', 'n')[0]['sum_n'], '123456789012345678901234567890.01')
        self.assertEqual(self.success('g,n\nx,-0.00\nx,1e-2\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')[0], {'g': 'x', 'sum_n': '0.01', 'avg_n': '0.005'})

    def test_group_only_and_empty(self):
        self.assertEqual(self.success('g\nz\na\nz\n', '--group-by', 'g'), [{'g': 'a'}, {'g': 'z'}])
        self.assertEqual(self.success('g,n\n', '--group-by', 'g', '--sum', 'n'), [])
        result = self.run_cli('g,n\n', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['g', 'n']])

    def test_csv_roundtrip(self):
        result = self.run_cli('a,b\n"x,y","one\ntwo"\n', '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['a', 'b'], ['x,y', 'one\ntwo']])

    def test_errors(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'),
                 ('a,b\nx\n', (), 'row 2'), ('a\n"unfinished', (), 'malformed CSV'),
                 ('a\nx\n', ('--where', 'a'), 'malformed filter'),
                 ('a\nx\n', ('--where', '=x'), 'malformed filter'),
                 ('a\nx\n', ('--where', 'b=x'), 'unknown column'),
                 ('a\nx\n', ('--group-by', 'b'), 'unknown column'),
                 ('a\nx\n', ('--sum', 'a'), 'require'),
                 ('a\nx\n', ('--output', 'xml'), 'invalid choice'),
                 ('a\nx\n', ('--bogus',), 'unrecognized arguments'),
                 ('a,b\nx\n', ('--where', 'a=no'), 'row 2')]
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numbers(self):
        for value in ('', 'no', 'NaN', 'Infinity', '1_000', ' '):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\nx,{value}\n', '--group-by', 'g', '--sum', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'n'", result.stderr)
        self.assertEqual(self.success('g,n\nx,no\ny,2\n', '--where', 'g=y', '--group-by', 'g', '--sum', 'n'), [{'g': 'y', 'sum_n': '2'}])


if __name__ == '__main__':
    unittest.main()
