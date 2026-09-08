import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


MAIN = Path(__file__).with_name('main.py')


class CliTests(unittest.TestCase):
    def run_cli(self, text, *args):
        with tempfile.TemporaryDirectory(dir=MAIN.parent) as directory:
            path = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(MAIN), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_quotes_newlines_and_order(self):
        self.assertEqual(self.success('id,note\r\n2,"a,b"\r\n1,"a\n""b"""\r\n'),
                         [{'id': '2', 'note': 'a,b'}, {'id': '1', 'note': 'a\n"b"'}])

    def test_filters(self):
        data = 'a,b\nx,1\nx,2\ny,2\n'
        self.assertEqual(self.success(data, '--where', 'a=x', '--where', 'b=2'), [{'a': 'x', 'b': '2'}])
        self.assertEqual(self.success('a,b\nx=y,\n', '--where', 'a=x=y', '--where', 'b='), [{'a': 'x=y', 'b': ''}])

    def test_aggregates(self):
        self.assertEqual(self.success('g,n\nb,0.1\na,2\nb,0.2\na,3\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n'),
                         [{'g': 'a', 'sum_n': '5', 'avg_n': '2.5'}, {'g': 'b', 'sum_n': '0.3', 'avg_n': '0.15'}])

    def test_precision(self):
        data = 'g,n\nx,1000000000000000000000000000000\nx,0.01\nx,-1000000000000000000000000000000\n'
        self.assertEqual(self.success(data, '--group-by', 'g', '--sum', 'n')[0]['sum_n'], '0.01')
        self.assertEqual(self.success('g,n\nx,-0.00\nx,1e-2\n', '--group-by', 'g', '--sum', 'n')[0]['sum_n'], '0.01')

    def test_group_only_and_empty(self):
        self.assertEqual(self.success('g\nz\na\nz\n', '--group-by', 'g'), [{'g': 'a'}, {'g': 'z'}])
        self.assertEqual(self.success('g,n\n', '--group-by', 'g', '--avg', 'n'), [])
        result = self.run_cli('a,b\n', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['a', 'b']])

    def test_csv_roundtrip(self):
        text = 'a,b\n"x,y","hello\n""world"""\n'
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(text))))

    def test_invalid_csv(self):
        for text in ['', ',b\n', 'a,a\n', 'a,b\nx\n', 'a\nx,y\n', 'a\n"unterminated\n', 'a\n"x"y\n', 'a\nx"y\n']:
            with self.subTest(text=text):
                result = self.run_cli(text)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_options(self):
        for args in [('--sum', 'n'), ('--avg', 'n'), ('--where', 'x'), ('--where', '=x'), ('--where', 'missing=x'), ('--group-by', 'missing'), ('--group-by', 'g', '--sum', 'missing'), ('--output', 'xml'), ('--unknown',)]:
            with self.subTest(args=args):
                result = self.run_cli('g,n\nx,1\n', *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numbers(self):
        for value in ['', ' ', 'oops', 'NaN', 'Infinity', '1_000']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\nx,{value}\n', '--group-by', 'g', '--sum', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)
                self.assertEqual(result.stdout, '')

    def test_filter_before_numeric_validation(self):
        self.assertEqual(self.success('g,n\nx,invalid\ny,4\n', '--where', 'g=y', '--group-by', 'g', '--avg', 'n'), [{'g': 'y', 'avg_n': '4'}])
        result = self.run_cli('g,n\nx,1,extra\n', '--where', 'g=y')
        self.assertNotEqual(result.returncode, 0)

    def test_bom(self):
        self.assertEqual(self.success('\ufeffg,n\nx,1\n'), [{'g': 'x', 'n': '1'}])


if __name__ == '__main__':
    unittest.main()
