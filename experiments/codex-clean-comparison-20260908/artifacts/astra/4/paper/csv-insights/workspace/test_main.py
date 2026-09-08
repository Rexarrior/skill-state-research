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
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def test_filter_order_and_quoting(self):
        result = self.run_cli('name,kind,note\r\n"A,B",x,"line1\nline2"\r\nC,y,no\r\nD,x,"a=""b"""\r\n', '--where', 'kind=x')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'name': 'A,B', 'kind': 'x', 'note': 'line1\nline2'}, {'name': 'D', 'kind': 'x', 'note': 'a="b"'}])

    def test_and_and_equals(self):
        result = self.run_cli('a,b\nx,=v\nx,v\ny,=v\n', '--where', 'a=x', '--where', 'b==v')
        self.assertEqual(json.loads(result.stdout), [{'a': 'x', 'b': '=v'}])

    def test_aggregates(self):
        result = self.run_cli('g,n,m\nz,0.1,3\na,2.00,1\nz,0.2,4\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '2', 'avg_m': '1'}, {'g': 'z', 'sum_n': '0.3', 'avg_m': '3.5'}])

    def test_exact_large_sum_and_cancellation(self):
        result = self.run_cli('g,n\na,1000000000000000000000000000000\na,0.01\na,-1000000000000000000000000000000\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '0.01'}])

    def test_csv_roundtrip_and_empty(self):
        text = 'a,b\r\n"x,y","one\ntwo"\r\n'
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['a', 'b'], ['x,y', 'one\ntwo']])
        result = self.run_cli(text, '--where', 'a=no', '--output', 'csv')
        self.assertEqual(result.stdout, 'a,b\n')
        self.assertEqual(json.loads(self.run_cli('a,b\n').stdout), [])

    def test_group_only_and_empty_aggregate(self):
        self.assertEqual(json.loads(self.run_cli('g\nz\na\nz\n', '--group-by', 'g').stdout), [{'g': 'a'}, {'g': 'z'}])
        self.assertEqual(json.loads(self.run_cli('g,n\n', '--group-by', 'g', '--avg', 'n').stdout), [])

    def test_invalid_inputs(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'), ('a,b\nx\n', (), 'row 2'), ('a\n"unclosed\n', (), 'malformed CSV'), ('a\nx\n', ('--where', 'bad'), 'malformed filter'), ('a\nx\n', ('--where', 'b=x'), 'unknown column'), ('a\nx\n', ('--sum', 'a'), 'require'), ('a\nx\n', ('--output', 'xml'), 'invalid choice'), ('a\nx\n', ('--wat',), 'unrecognized')]
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numbers(self):
        for value in ('', 'abc', 'NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_filtered_numeric_and_unfiltered_width_validation(self):
        result = self.run_cli('g,n\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'b', 'sum_n': '2'}])
        result = self.run_cli('g,n\na\n', '--where', 'g=b')
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
