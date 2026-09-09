import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def run_cli(self, content, *args, success=True):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / 'input.csv'
            data = content.encode('utf-8')
            path.write_bytes(data)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), data)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, '')
        return result

    def test_quoted_roundtrip_and_filters(self):
        text = 'name,note,status\r\n"a,b","first\nsecond",yes\r\nx,"say ""hi""",no\r\nx,a=b,yes\r\n'
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(text))))
        result = self.run_cli(text, '--where', 'status=yes', '--where', 'note=a=b')
        self.assertEqual(json.loads(result.stdout), [{'name': 'x', 'note': 'a=b', 'status': 'yes'}])

    def test_aggregates(self):
        result = self.run_cli('g,n,m\nb,0.1,2\na,1e-2,4\nb,0.2,3\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '0.01', 'avg_m': '4'}, {'g': 'b', 'sum_n': '0.3', 'avg_m': '2.5'}])

    def test_exact_large_sum(self):
        result = self.run_cli('g,n\na,123456789012345678901234567890\na,0.01\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '123456789012345678901234567890.01')

    def test_group_only_and_empty(self):
        self.assertEqual(json.loads(self.run_cli('g,n\nb,1\na,2\nb,3\n', '--group-by', 'g').stdout), [{'g': 'b', 'n': '1'}, {'g': 'a', 'n': '2'}, {'g': 'b', 'n': '3'}])
        self.assertEqual(json.loads(self.run_cli('g,n\n', '--group-by', 'g', '--sum', 'n').stdout), [])
        self.assertEqual(self.run_cli('g,n\na,1\n', '--where', 'g=z', '--output', 'csv').stdout, 'g,n\n')

    def test_same_column_aggregates_and_zero(self):
        result = self.run_cli('g,n\nz,-0.00\na,0.10\na,0.20\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [
            ['g', 'sum_n', 'avg_n'], ['a', '0.3', '0.15'], ['z', '0', '0']])

    def test_filtered_aggregation_and_exact_filters(self):
        text = 'g,n,flag\nb,3,yes\na,2,Yes\nb,1,yes\na,100,no\n'
        result = self.run_cli(text, '--where', 'flag=yes', '--group-by', 'g', '--avg', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'b', 'avg_n': '2'}])
        result = self.run_cli('g,n\na,\nb,1\n', '--where', 'n=')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'n': ''}])

    def test_malformed_filtered_record_is_error(self):
        self.run_cli('g,n\na,1\nb,2,extra\n', '--where', 'g=a', success=False)

    def test_invalid_inputs(self):
        for text in ('', ',n\na,1\n', 'g,g\na,1\n', 'g,n\na\n', 'g,n\na,1,2\n', 'g,n\na,"unclosed\n', 'g,n\na,"1"x\n'):
            with self.subTest(text=text):
                self.run_cli(text, success=False)

    def test_invalid_arguments(self):
        for args in (('--sum', 'n'), ('--avg', 'n'), ('--where', 'x'), ('--where', '=x'), ('--where', 'unknown=x'), ('--group-by', 'unknown'), ('--group-by', 'g', '--sum', 'unknown'), ('--output', 'yaml'), ('--wat',)):
            with self.subTest(args=args):
                self.run_cli('g,n\na,1\n', *args, success=False)

    def test_invalid_numbers(self):
        for value in ('', 'x', 'NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n', success=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)
        self.assertEqual(json.loads(self.run_cli('g,n\na,invalid\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n').stdout), [])


if __name__ == '__main__':
    unittest.main()
