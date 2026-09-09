import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def run_cli(self, data, *args):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / 'input.csv'
            original = data.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def test_quotes_multiline_and_filters(self):
        result = self.run_cli('name,note,tag\r\n"a,b","one\ntwo",x=y\r\nz,no,q\r\n', '--where', 'tag=x=y', '--where', 'name=a,b')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'name': 'a,b', 'note': 'one\ntwo', 'tag': 'x=y'}])

    def test_aggregates(self):
        result = self.run_cli('g,n\nb,0.1\na,3\nb,0.2\na,2\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '5', 'avg_n': '2.5'}, {'g': 'b', 'sum_n': '0.3', 'avg_n': '0.15'}])

    def test_precision(self):
        result = self.run_cli('g,n\na,10000000000000000000000000000\na,0.01\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '10000000000000000000000000000.01')

    def test_csv_roundtrip(self):
        data = 'g,n\n"a,b","x\ny"\n'
        result = self.run_cli(data, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(data))))

    def test_empty_and_group_only(self):
        self.assertEqual(json.loads(self.run_cli('g,n\n').stdout), [])
        result = self.run_cli('g,n\nb,1\na,2\nb,3\n', '--group-by', 'g')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a'}, {'g': 'b'}])
        self.assertEqual(self.run_cli('g,n\n', '--output', 'csv').stdout, 'g,n\n')

    def test_errors(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'), ('a,b\nx\n', (), 'row 2'), ('a\n"unfinished', (), 'error'), ('a\nx\n', ('--where', 'oops'), 'filter'), ('a\nx\n', ('--where', 'b=x'), 'unknown column'), ('a\nx\n', ('--sum', 'a'), 'require'), ('a\nx\n', ('--output', 'xml'), 'invalid choice'), ('a\nx\n', ('--group-by', 'b'), 'unknown column')]
        for data, args, message in cases:
            with self.subTest(data=data, args=args):
                result = self.run_cli(data, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numbers(self):
        for value in ('', 'oops', 'NaN', 'Infinity', '1_000'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_filtered_values_and_width(self):
        result = self.run_cli('g,n\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'b', 'sum_n': '2'}])
        self.assertNotEqual(self.run_cli('g,n\na\n', '--where', 'g=b').returncode, 0)


if __name__ == '__main__':
    unittest.main()
