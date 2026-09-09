import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MAIN = Path(__file__).with_name('main.py')


class CLITests(unittest.TestCase):
    def run_cli(self, text, *args, ok=True):
        with tempfile.TemporaryDirectory(dir=MAIN.parent) as directory:
            source = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            source.write_bytes(original)
            result = subprocess.run([sys.executable, str(MAIN), str(source), *args], capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), original)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, '')
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr.strip())
            self.assertEqual(result.stdout, '')
        return result

    def test_quotes_newlines_and_filters(self):
        text = 'name,note,flag\r\n"A,B","line1\nline2",yes\r\nC,x=no,yes\r\nD,x=no,no\r\n'
        rows = json.loads(self.run_cli(text).stdout)
        self.assertEqual(rows[0], {'name': 'A,B', 'note': 'line1\nline2', 'flag': 'yes'})
        filtered = self.run_cli(text, '--where', 'note=x=no', '--where', 'flag=yes', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(filtered.stdout))), [['name', 'note', 'flag'], ['C', 'x=no', 'yes']])
        roundtrip = self.run_cli(text, '--output', 'csv').stdout
        self.assertEqual(list(csv.DictReader(io.StringIO(roundtrip))), rows)

    def test_aggregates(self):
        result = self.run_cli('g,n,m\nz,0.1,1\na,2,4\nz,0.2,2\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '2', 'avg_m': '4'}, {'g': 'z', 'sum_n': '0.3', 'avg_m': '1.5'}])

    def test_precision(self):
        text = 'g,n\na,123456789012345678901234567890\na,0.01\n'
        rows = json.loads(self.run_cli(text, '--group-by', 'g', '--sum', 'n').stdout)
        self.assertEqual(rows[0]['sum_n'], '123456789012345678901234567890.01')
        rows = json.loads(self.run_cli('g,n\na,1e-2\na,-0.01\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n').stdout)
        self.assertEqual(rows[0], {'g': 'a', 'sum_n': '0', 'avg_n': '0'})

    def test_empty_and_groups(self):
        self.assertEqual(json.loads(self.run_cli('g,n\nz,1\na,2\nz,3\n', '--group-by', 'g').stdout), [{'g': 'a'}, {'g': 'z'}])
        self.assertEqual(self.run_cli('g,n\n', '--group-by', 'g', '--sum', 'n', '--output', 'csv').stdout, 'g,sum_n\n')
        self.assertEqual(json.loads(self.run_cli('g,n\na,\n', '--where', 'n=').stdout), [{'g': 'a', 'n': ''}])

    def test_invalid_inputs(self):
        for text in ['', ',b\n', 'a,a\n', 'a,b\n1\n', 'a\n1,2\n', 'a\n"unterminated', 'a\n"x"junk\n']:
            with self.subTest(text=text):
                self.run_cli(text, ok=False)

    def test_invalid_arguments(self):
        for args in [('--where', 'bad'), ('--where', '=x'), ('--where', 'missing=x'), ('--sum', 'n'), ('--avg', 'n'), ('--group-by', 'missing'), ('--output', 'xml'), ('--nonsense',), ('--group-by', 'g', '--sum', 'missing')]:
            with self.subTest(args=args):
                self.run_cli('g,n\na,1\n', *args, ok=False)

    def test_numeric_errors_and_filtered_rows(self):
        for value in ['', 'bad', 'NaN', 'Infinity', '-Infinity']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--sum', 'n', ok=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)
        self.assertEqual(json.loads(self.run_cli('g,n\na,bad\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n').stdout), [])
        self.run_cli('g,n\na\n', '--where', 'g=b', ok=False)


if __name__ == '__main__':
    unittest.main()
