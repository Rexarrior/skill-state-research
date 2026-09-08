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
            original = content.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name('main.py')), str(path), *args],
                capture_output=True, text=True,
            )
            self.assertEqual(path.read_bytes(), original)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, '')
        return result

    def test_csv_roundtrip_and_filters(self):
        content = 'name,tag,note\r\n"A, B",x,"line 1\nline ""2"""\r\nC,x,other\r\nD,y,other\r\n'
        result = self.run_cli(content, '--where', 'tag=x', '--where', 'name=A, B')
        expected = [{'name': 'A, B', 'tag': 'x', 'note': 'line 1\nline "2"'}]
        self.assertEqual(json.loads(result.stdout), expected)
        result = self.run_cli(content, '--where', 'name=A, B', '--output', 'csv')
        self.assertEqual(list(csv.DictReader(io.StringIO(result.stdout))), expected)

    def test_aggregates(self):
        result = self.run_cli('g,n,m\nb,0.1,1\na,2.50,3\nb,0.2,2\na,-0.50,4\n',
                              '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(json.loads(result.stdout), [
            {'g': 'a', 'sum_n': '2', 'avg_m': '3.5'},
            {'g': 'b', 'sum_n': '0.3', 'avg_m': '1.5'}])

    def test_large_precision_and_same_column(self):
        n = '123456789012345678901234567890'
        result = self.run_cli(f'g,n\nx,{n}.01\nx,0.01\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(json.loads(result.stdout)[0], {
            'g': 'x', 'sum_n': n + '.02', 'avg_n': '61728394506172839450617283945.01'})

    def test_empty_and_group_without_aggregation(self):
        self.assertEqual(json.loads(self.run_cli('a,b\n').stdout), [])
        self.assertEqual(self.run_cli('a,b\n', '--output', 'csv').stdout, 'a,b\n')
        result = self.run_cli('a,b\nz,1\na,2\nz,3\n', '--group-by', 'a')
        self.assertEqual(json.loads(result.stdout), [{'a': 'z', 'b': '1'}, {'a': 'a', 'b': '2'}, {'a': 'z', 'b': '3'}])
        self.assertEqual(json.loads(self.run_cli('a,b\nx,1\n', '--where', 'a=q').stdout), [])

    def test_numeric_formats(self):
        result = self.run_cli('g,n\na,1e-2\nb,-0.00\nc, 2.500 \n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual([row['sum_n'] for row in json.loads(result.stdout)], ['0.01', '0', '2.5'])

    def test_invalid_input(self):
        for content in ['', ',b\n', 'a,a\n', 'a,b\nx\n', 'a\nx,y\n', 'a\n"unterminated', 'a\n"x"oops\n']:
            with self.subTest(content=content):
                self.run_cli(content, success=False)

    def test_invalid_arguments(self):
        for args in [('--where', 'a'), ('--where', '=x'), ('--where', 'q=x'),
                     ('--group-by', 'q'), ('--sum', 'a'), ('--avg', 'a'),
                     ('--group-by', 'a', '--avg', 'q'), ('--output', 'xml'), ('--bogus',)]:
            with self.subTest(args=args):
                self.run_cli('a,b\nx,1\n', *args, success=False)

    def test_numeric_errors_and_filter_order(self):
        for value in ['', 'no', 'NaN', 'Infinity', '1_000']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\nx,{value}\n', '--group-by', 'g', '--sum', 'n', success=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)
        self.run_cli('g,n\nx,bad\ny,1\n', '--where', 'g=y', '--group-by', 'g', '--sum', 'n')
        self.run_cli('g,n\nx\ny,1\n', '--where', 'g=y', success=False)

    def test_equals_and_empty_filter_values(self):
        content = 'k,v\na=b,\na,c\n'
        result = self.run_cli(content, '--where', 'k=a=b', '--where', 'v=')
        self.assertEqual(json.loads(result.stdout), [{'k': 'a=b', 'v': ''}])


if __name__ == '__main__':
    unittest.main()
