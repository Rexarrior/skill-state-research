import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MAIN = Path(__file__).resolve().parents[1] / 'main.py'


class CLITests(unittest.TestCase):
    def run_cli(self, text, *args, ok=True):
        with tempfile.TemporaryDirectory(dir=MAIN.parent) as directory:
            path = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(MAIN), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, '')
        return result

    def test_quoted_fields_and_filters(self):
        text = 'id,note,tag\r\n1,"hello, world",x=y\r\n2,"two\nlines",x=y\r\n3,no,z\r\n'
        result = self.run_cli(text, '--where', 'tag=x=y', '--where', 'id=2')
        self.assertEqual(json.loads(result.stdout), [{'id': '2', 'note': 'two\nlines', 'tag': 'x=y'}])
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(text))))

    def test_aggregates(self):
        result = self.run_cli('g,n\nb,0.1\na,2\nb,0.2\na,3\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(json.loads(result.stdout), [
            {'g': 'a', 'sum_n': '5', 'avg_n': '2.5'},
            {'g': 'b', 'sum_n': '0.3', 'avg_n': '0.15'}])

    def test_precision_and_notation(self):
        result = self.run_cli('g,n\nx,1000000000000000000000000000000\nx,0.01\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '1000000000000000000000000000000.01')
        result = self.run_cli('g,n\nx,-0.00\nx,1e-2\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '0.01')

    def test_empty_and_distinct(self):
        self.assertEqual(json.loads(self.run_cli('g,n\n', '--group-by', 'g', '--sum', 'n').stdout), [])
        self.assertEqual(self.run_cli('g,n\n', '--output', 'csv').stdout, 'g,n\n')
        self.assertEqual(json.loads(self.run_cli('g\nb\na\nb\n', '--group-by', 'g').stdout), [{'g': 'a'}, {'g': 'b'}])

    def test_invalid_tables(self):
        for text in ('', ',b\n', 'a,a\n', 'a,b\n1\n', 'a\n1,2\n', 'a\n"unterminated', 'a\n"x"oops\n'):
            with self.subTest(text=text):
                self.run_cli(text, ok=False)

    def test_invalid_arguments(self):
        for args in (('--sum', 'n'), ('--avg', 'n'), ('--where', 'bad'), ('--where', '=x'),
                     ('--where', 'missing=x'), ('--group-by', 'missing'),
                     ('--group-by', 'g', '--sum', 'missing'), ('--output', 'xml'), ('--bogus',)):
            with self.subTest(args=args):
                self.run_cli('g,n\nx,1\n', *args, ok=False)

    def test_numeric_errors(self):
        for value in ('', 'abc', 'NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\nx,{value}\n', '--group-by', 'g', '--sum', 'n', ok=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)
        self.run_cli('g,n\nx,bad\ny,1\n', '--where', 'g=y', '--group-by', 'g', '--sum', 'n')


if __name__ == '__main__':
    unittest.main()
