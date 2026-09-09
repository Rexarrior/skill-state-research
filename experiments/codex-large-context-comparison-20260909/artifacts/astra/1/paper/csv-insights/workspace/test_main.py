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

    def test_quoted_and_multiline_roundtrip(self):
        text = 'name,note\r\n"Doe, Jane","line 1\nline ""2"""\r\n'
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(text))))

    def test_filters_and_input_order(self):
        result = self.run_cli('id,x,y\n3,a,b=c\n1,a,b=c\n2,a,z\n4,b,b=c\n', '--where', 'x=a', '--where', 'y=b=c')
        self.assertEqual([r['id'] for r in json.loads(result.stdout)], ['3', '1'])

    def test_aggregation(self):
        result = self.run_cli('g,n,m\nz,0.1,1\na,1e-2,2\nz,0.2,4\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '0.01', 'avg_m': '2'}, {'g': 'z', 'sum_n': '0.3', 'avg_m': '2.5'}])

    def test_exact_large_sum(self):
        result = self.run_cli('g,n\na,1000000000000000000000000000000\na,0.01\na,-1000000000000000000000000000000\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '0.01')

    def test_invalid_inputs(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'), ('a,b\nx\n', (), 'row 2'), ('a\n"unterminated', (), 'error'), ('a\nx\n', ('--where', 'bad'), 'filter'), ('a\nx\n', ('--where', '=x'), 'filter'), ('a\nx\n', ('--where', 'b=x'), 'unknown'), ('a\nx\n', ('--sum', 'a'), 'require'), ('a\nx\n', ('--output', 'xml'), 'invalid choice'), ('a\nx\n', ('--bogus',), 'unrecognized')]
        for text, args, expected in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_bad_numbers(self):
        for value in ('', 'oops', 'NaN', 'Infinity'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'n'", result.stderr)

    def test_empty_result_and_filtered_bad_number(self):
        text = 'g,n\na,bad\n'
        result = self.run_cli(text, '--where', 'g=b', '--group-by', 'g', '--sum', 'n', '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'g,sum_n\n')
        self.assertEqual(json.loads(self.run_cli(text, '--where', 'g=b').stdout), [])

    def test_group_by_without_aggregate(self):
        result = self.run_cli('g,n\nz,1\na,2\nz,3\n', '--group-by', 'g')
        self.assertEqual([r['g'] for r in json.loads(result.stdout)], ['z', 'a', 'z'])


if __name__ == '__main__':
    unittest.main()
