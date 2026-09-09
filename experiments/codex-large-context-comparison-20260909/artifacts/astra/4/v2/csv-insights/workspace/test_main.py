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
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')),
                                     str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_filters_and_quoted_records(self):
        text = 'name,note,kind\r\n"a,b","line1\nline2",yes\r\nz,x=no,no\r\nx,x=no,yes\r\n'
        rows = self.success(text)
        self.assertEqual(rows[0]['note'], 'line1\nline2')
        self.assertEqual(rows[0]['name'], 'a,b')
        self.assertEqual(self.success(text, '--where', 'note=x=no', '--where', 'kind=yes'),
                         [{'name': 'x', 'note': 'x=no', 'kind': 'yes'}])
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))),
                         list(csv.reader(io.StringIO(text))))

    def test_aggregates(self):
        self.assertEqual(self.success('g,n,m\nb,0.1,1\na,2.50,3\nb,0.2,2\n',
                                      '--group-by', 'g', '--sum', 'n', '--avg', 'm'),
                         [{'g': 'a', 'sum_n': '2.5', 'avg_m': '3'},
                          {'g': 'b', 'sum_n': '0.3', 'avg_m': '1.5'}])
        self.assertEqual(self.success('g,n\nx,10000000000000000000000000000\nx,0.01\n',
                                      '--group-by', 'g', '--sum', 'n')[0]['sum_n'],
                         '10000000000000000000000000000.01')
        self.assertEqual(self.success('g,n\nx,-0.00\n', '--group-by', 'g', '--avg', 'n'),
                         [{'g': 'x', 'avg_n': '0'}])

    def test_empty_and_distinct(self):
        self.assertEqual(self.success('g,n\n'), [])
        self.assertEqual(self.success('g,n\nb,1\na,2\nb,3\n', '--group-by', 'g'),
                         [{'g': 'a'}, {'g': 'b'}])
        result = self.run_cli('g,n\n', '--group-by', 'g', '--sum', 'n', '--output', 'csv')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, 'g,sum_n\n')

    def test_invalid_input_and_arguments(self):
        cases = [('', (), 'header'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'),
                 ('a,b\n1\n', (), 'row 2'), ('a\n1,2\n', (), 'row 2'),
                 ('a\n"unclosed', (), 'malformed CSV'),
                 ('a\n"x"oops\n', (), 'malformed CSV'),
                 ('a\nx\n', ('--where', 'a'), 'filter'),
                 ('a\nx\n', ('--where', '=x'), 'filter'),
                 ('a\nx\n', ('--where', 'b=x'), 'unknown column'),
                 ('a\nx\n', ('--group-by', 'b'), 'unknown column'),
                 ('a\nx\n', ('--sum', 'a'), 'require'),
                 ('a\nx\n', ('--avg', 'a'), 'require'),
                 ('a\nx\n', ('--output', 'xml'), 'invalid choice')]
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_numeric_errors_and_filtering(self):
        for value in ('', 'abc', 'NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\nx,{value}\n', '--group-by', 'g', '--sum', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'n'", result.stderr)
        self.assertEqual(self.success('g,n\nx,bad\ny,2\n', '--where', 'g=y',
                                      '--group-by', 'g', '--avg', 'n'),
                         [{'g': 'y', 'avg_n': '2'}])


if __name__ == '__main__':
    unittest.main()
