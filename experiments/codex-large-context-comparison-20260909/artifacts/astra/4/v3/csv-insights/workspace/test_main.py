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

    def test_quoted_csv_and_filters(self):
        result = self.run_cli('name,note,kind\r\n"A,B","two\nlines",x\r\nC,a=b,x\r\nD,a=b,y\r\n', '--where', 'note=a=b', '--where', 'kind=x')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'name': 'C', 'note': 'a=b', 'kind': 'x'}])
        result = self.run_cli('name,note\r\n"A,B","two\nlines"\r\n', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['name', 'note'], ['A,B', 'two\nlines']])

    def test_decimal_aggregates(self):
        result = self.run_cli('g,n\nb,0.1\na,2\nb,0.2\na,3\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '5', 'avg_n': '2.5'}, {'g': 'b', 'sum_n': '0.3', 'avg_n': '0.15'}])
        result = self.run_cli('g,n\na,1000000000000000000000000000000\na,0.01\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '1000000000000000000000000000000.01')

    def test_empty_and_group_only(self):
        result = self.run_cli('a,b\n', '--output', 'csv')
        self.assertEqual(result.stdout, 'a,b\n')
        result = self.run_cli('g,n\nb,1\na,2\nb,3\n', '--group-by', 'g')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a'}, {'g': 'b'}])
        result = self.run_cli('g,n\na,1\n', '--where', 'g=', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [])

    def test_errors(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'), ('a,b\nx\n', (), 'row 2'), ('a\n"unterminated', (), 'malformed CSV'), ('a\nx\n', ('--where', 'missing=x'), 'unknown column'), ('a\nx\n', ('--where', 'a'), 'malformed filter'), ('a\nx\n', ('--sum', 'a'), 'require --group-by'), ('a\nx\n', ('--output', 'xml'), 'invalid choice')]
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')
        for value in ('', 'oops', 'NaN', 'Infinity', '1_000'):
            result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("row 2, column 'n'", result.stderr)


if __name__ == '__main__':
    unittest.main()
