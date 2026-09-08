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
            source = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            source.write_bytes(original)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(source), *args], capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_quoted_fields_and_order(self):
        self.assertEqual(self.success('name,note\r\nz,"a,b"\r\na,"line1\nline2 ""yes"""\r\n'), [dict(name='z', note='a,b'), dict(name='a', note='line1\nline2 "yes"')])

    def test_filters(self):
        self.assertEqual(self.success('a,b\nx,=z\nx,k\ny,=z\n', '--where', 'a=x', '--where', 'b==z'), [{'a': 'x', 'b': '=z'}])
        self.assertEqual(self.success('a,b\nx,\n', '--where', 'b='), [{'a': 'x', 'b': ''}])

    def test_aggregates(self):
        self.assertEqual(self.success('g,n,m\nz,0.1,1\na,2.00,4\nz,0.2,2\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm'), [{'g': 'a', 'sum_n': '2', 'avg_m': '4'}, {'g': 'z', 'sum_n': '0.3', 'avg_m': '1.5'}])

    def test_precision_and_minimal_numbers(self):
        self.assertEqual(self.success('g,n\nx,1000000000000000000000000000000\nx,0.01\n', '--group-by', 'g', '--sum', 'n')[0]['sum_n'], '1000000000000000000000000000000.01')
        self.assertEqual(self.success('g,n\nx,-0.00\ny,1e-2\n', '--group-by', 'g', '--sum', 'n'), [{'g': 'x', 'sum_n': '0'}, {'g': 'y', 'sum_n': '0.01'}])

    def test_repeating_average(self):
        self.assertEqual(self.success('g,n\nx,1\nx,0\nx,0\n', '--group-by', 'g', '--avg', 'n')[0]['avg_n'], '0.3333333333333333333333333333')

    def test_csv_roundtrip(self):
        result = self.run_cli('a,b\nx,"hello,\n""world"""\n', '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['a', 'b'], ['x', 'hello,\n"world"']])

    def test_empty_results(self):
        self.assertEqual(self.success('g,n\n', '--group-by', 'g', '--sum', 'n'), [])
        self.assertEqual(self.run_cli('g,n\n', '--output', 'csv').stdout, 'g,n\n')

    def test_group_only(self):
        self.assertEqual(self.success('g\nz\na\nz\n', '--group-by', 'g'), [{'g': 'z'}, {'g': 'a'}, {'g': 'z'}])

    def test_bad_input(self):
        for text, message in [('', 'headers'), ('a,\n', 'headers'), ('a,a\n', 'unique'), ('a,b\nx\n', 'row 2'), ('a\nx,y\n', 'row 2'), ('a\n"unfinished', 'malformed CSV'), ('a\n"x"junk\n', 'malformed CSV')]:
            with self.subTest(text=text):
                result = self.run_cli(text)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_bad_numbers(self):
        for value in ['', 'oops', 'NaN', 'Infinity', '-Infinity']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\nx,{value}\n', '--group-by', 'g', '--sum', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_invalid_arguments(self):
        for args in [('--sum', 'n'), ('--avg', 'n'), ('--where', 'oops'), ('--where', '=x'), ('--where', 'missing=x'), ('--group-by', 'missing'), ('--group-by', 'g', '--sum', 'missing'), ('--output', 'yaml'), ('--unknown',)]:
            with self.subTest(args=args):
                result = self.run_cli('g,n\nx,1\n', *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)

    def test_filter_before_numeric_validation(self):
        self.assertEqual(self.success('g,n\nx,bad\ny,2\n', '--where', 'g=y', '--group-by', 'g', '--sum', 'n'), [{'g': 'y', 'sum_n': '2'}])
        result = self.run_cli('g,n\nx,bad,extra\n', '--where', 'g=y')
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
