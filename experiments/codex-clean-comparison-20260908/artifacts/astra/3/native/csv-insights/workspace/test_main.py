"""End-to-end CLI tests; temporary input files stay in the project directory."""
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
    def run_cli(self, content, *args):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / 'input.csv'
            data = content.encode('utf-8') if isinstance(content, str) else content
            path.write_bytes(data)
            result = subprocess.run([sys.executable, str(ROOT / 'main.py'), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), data, 'input was modified')
            return result

    def success(self, content, *args):
        result = self.run_cli(content, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def failure(self, content, args, message):
        result = self.run_cli(content, *args)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertEqual(result.stdout, '')

    def test_quoted_fields_and_newlines(self):
        self.assertEqual(self.success('name,note\r\n"A,B","first\r\nsecond ""quoted"""\r\n'),
                         [{'name': 'A,B', 'note': 'first\r\nsecond "quoted"'}])

    def test_filters_and_input_order(self):
        self.assertEqual(self.success('a,b,c\nz,x,1\ny,x,2\nz,x,3\nz,y,4\n',
                                     '--where', 'a=z', '--where', 'b=x'),
                         [{'a': 'z', 'b': 'x', 'c': '1'}, {'a': 'z', 'b': 'x', 'c': '3'}])

    def test_filter_empty_and_equals(self):
        self.assertEqual(self.success('a,b\nx=y,\nx,y\n', '--where', 'a=x=y', '--where', 'b='),
                         [{'a': 'x=y', 'b': ''}])

    def test_aggregates_sorted_and_minimal(self):
        self.assertEqual(self.success('g,x,y\nb,0.10,2\na,1e-2,5\nb,0.20,3\n',
                                     '--group-by', 'g', '--sum', 'x', '--avg', 'y'),
                         [{'g': 'a', 'sum_x': '0.01', 'avg_y': '5'},
                          {'g': 'b', 'sum_x': '0.3', 'avg_y': '2.5'}])

    def test_exact_large_sum(self):
        self.assertEqual(self.success('g,n\na,123456789012345678901234567890\na,0.01\n',
                                     '--group-by', 'g', '--sum', 'n')[0]['sum_n'],
                         '123456789012345678901234567890.01')

    def test_average_and_signed_zero(self):
        self.assertEqual(self.success('g,n\na,1\na,0\na,0\nb,-0.00\n',
                                     '--group-by', 'g', '--avg', 'n'),
                         [{'g': 'a', 'avg_n': '0.3333333333333333333333333333'},
                          {'g': 'b', 'avg_n': '0'}])

    def test_same_column_sum_and_average(self):
        self.assertEqual(self.success('g,n\na,1\na,4\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n'),
                         [{'g': 'a', 'sum_n': '5', 'avg_n': '2.5'}])

    def test_group_only(self):
        self.assertEqual(self.success('g,n\nb,1\na,2\nb,3\n', '--group-by', 'g'),
                         [{'g': 'a'}, {'g': 'b'}])

    def test_empty_results(self):
        self.assertEqual(self.success('g,n\n', '--group-by', 'g', '--sum', 'n'), [])
        result = self.run_cli('g,n\na,1\n', '--where', 'g=b', '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'g,n\n')

    def test_csv_round_trip(self):
        result = self.run_cli('a,b\n"x,y","one\ntwo ""three"""\n', '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))),
                         [['a', 'b'], ['x,y', 'one\ntwo "three"']])

    def test_invalid_headers_and_rows(self):
        for content, message in [('', 'header'), ('a,a\n', 'unique'), ('a,\n', 'non-empty'),
                                 ('a,  \n', 'non-empty'), ('a,b\nx\n', 'row 2'),
                                 ('a,b\nx,y,z\n', 'row 2'), ('a,b\n\n', 'row 2'),
                                 ('a,b\n"unclosed,x\n', 'malformed CSV')]:
            with self.subTest(content=content):
                self.failure(content, [], message)

    def test_invalid_numerics(self):
        for cell in ['', 'oops', 'NaN', 'Infinity', '1_000']:
            with self.subTest(cell=cell):
                self.failure(f'g,n\na,{cell}\n', ['--group-by', 'g', '--sum', 'n'], "row 2, column 'n'")

    def test_filter_before_numeric_validation(self):
        self.assertEqual(self.success('g,n\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n'),
                         [{'g': 'b', 'sum_n': '2'}])
        self.failure('g,n\na,1,extra\n', ['--where', 'g=b'], 'row 2')

    def test_bad_arguments(self):
        for args, message in [(['--sum', 'n'], 'require --group-by'),
                              (['--avg', 'n'], 'require --group-by'),
                              (['--where', 'g'], 'malformed filter'),
                              (['--where', '=a'], 'malformed filter'),
                              (['--where', 'missing=a'], 'unknown column'),
                              (['--group-by', 'missing'], 'unknown column'),
                              (['--group-by', 'g', '--sum', 'missing'], 'unknown column'),
                              (['--output', 'yaml'], 'invalid choice'),
                              (['--wat'], 'unrecognized arguments')]:
            with self.subTest(args=args):
                self.failure('g,n\na,1\n', args, message)

    def test_output_name_collision(self):
        self.failure('sum_n,n\na,1\n', ['--group-by', 'sum_n', '--sum', 'n'], 'conflict')

    def test_encoding(self):
        self.assertEqual(self.success('\ufeffg,n\né,2\n'), [{'g': 'é', 'n': '2'}])
        self.failure(b'g,n\n\xff,2\n', [], 'error:')

    def test_missing_file(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            result = subprocess.run([sys.executable, str(ROOT / 'main.py'), str(Path(directory) / 'missing.csv')],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('error:', result.stderr)
            self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
