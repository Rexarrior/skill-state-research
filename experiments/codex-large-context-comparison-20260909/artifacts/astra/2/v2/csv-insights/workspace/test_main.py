import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def run_cli(self, content, *args, ok=True):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            source = Path(directory) / 'input.csv'
            data = content.encode('utf-8')
            source.write_bytes(data)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(source), *args], capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), data)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        if not ok:
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, '')
        return result

    def test_filter_and_quoted_records(self):
        result = self.run_cli('name,region,note\r\n"A,B",West,"first\nsecond"\r\nC,East,x\r\nD,West,"a""b"\r\n', '--where', 'region=West', '--where', 'name=A,B')
        self.assertEqual(json.loads(result.stdout), [{'name': 'A,B', 'region': 'West', 'note': 'first\nsecond'}])

    def test_decimal_aggregation(self):
        result = self.run_cli('g,n,m\nb,0.1,1\na,1e-2,10\nb,0.2,2\na,-0.01,20\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '0', 'avg_m': '15'}, {'g': 'b', 'sum_n': '0.3', 'avg_m': '1.5'}])

    def test_large_exact_sum(self):
        result = self.run_cli('g,n\na,10000000000000000000000000000\na,0.01\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '10000000000000000000000000000.01')

    def test_csv_round_trip(self):
        content = 'a,b\r\n"x,y","hello\nworld"\r\n"a""b",z\r\n'
        result = self.run_cli(content, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(content))))

    def test_empty_and_group_only(self):
        self.assertEqual(json.loads(self.run_cli('g,n\n').stdout), [])
        self.assertEqual(self.run_cli('g,n\n', '--group-by', 'g', '--sum', 'n', '--output', 'csv').stdout, 'g,sum_n\n')
        self.assertEqual(json.loads(self.run_cli('g\nb\na\nb\n', '--group-by', 'g').stdout), [{'g': 'a'}, {'g': 'b'}])

    def test_invalid_inputs(self):
        for content in ['', 'a,a\n1,2\n', 'a,\n1,2\n', 'a,b\n1\n', 'a\n1,2\n', 'a\n"unfinished', 'a\n"closed"junk\n', 'a\n\n']:
            with self.subTest(content=content):
                self.run_cli(content, ok=False)

    def test_invalid_options(self):
        for args in [('--sum', 'n'), ('--avg', 'n'), ('--where', 'bad'), ('--where', '=x'), ('--where', 'missing=x'), ('--group-by', 'missing'), ('--group-by', 'g', '--sum', 'missing'), ('--output', 'xml'), ('--unknown',), ('--where',)]:
            with self.subTest(args=args):
                self.run_cli('g,n\na,1\n', *args, ok=False)

    def test_numeric_errors(self):
        for value in ['', 'NaN', 'Infinity', 'abc', '1_000']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n', ok=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_filter_before_numeric_validation(self):
        result = self.run_cli('g,n\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'b', 'sum_n': '2'}])
        self.run_cli('g,n\na,bad,extra\nb,2\n', '--where', 'g=b', ok=False)

    def test_equals_and_empty_filter(self):
        self.assertEqual(json.loads(self.run_cli('a,b\nx=y,\nx,z\n', '--where', 'a=x=y', '--where', 'b=').stdout), [{'a': 'x=y', 'b': ''}])


if __name__ == '__main__':
    unittest.main()
