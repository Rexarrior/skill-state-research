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
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def test_filter_csv_and_json(self):
        text = 'name,status,note\r\n"a,b",ok,"first\nsecond"\r\nx,no,other\r\nz,ok,a=b\r\n'
        result = self.run_cli(text, '--where', 'status=ok')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'name': 'a,b', 'status': 'ok', 'note': 'first\nsecond'}, {'name': 'z', 'status': 'ok', 'note': 'a=b'}])
        result = self.run_cli(text, '--where', 'status=ok', '--where', 'note=a=b', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['name', 'status', 'note'], ['z', 'ok', 'a=b']])
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(text))))

    def test_aggregation(self):
        result = self.run_cli('g,n\nb,0.1\na,1.00\nb,0.2\na,4\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '5', 'avg_n': '2.5'}, {'g': 'b', 'sum_n': '0.3', 'avg_n': '0.15'}])
        result = self.run_cli('g,n\na,10000000000000000000000000000\na,0.01\na,-10000000000000000000000000000\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '0.01')

    def test_empty_and_groups(self):
        self.assertEqual(json.loads(self.run_cli('g,n\n', '--group-by', 'g', '--avg', 'n').stdout), [])
        self.assertEqual(self.run_cli('g,n\n', '--output', 'csv').stdout, 'g,n\n')
        self.assertEqual(json.loads(self.run_cli('g,n\nz,1\na,2\nz,3\n', '--group-by', 'g').stdout), [{'g': 'a'}, {'g': 'z'}])
        self.assertEqual(json.loads(self.run_cli('g,n\na,\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n').stdout), [{'g': 'b', 'sum_n': '2'}])

    def test_errors(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'), ('a,b\n1\n', (), 'row 2'), ('a\n"unclosed\n', (), 'malformed CSV'), ('a\n1\n', ('--where', 'bad'), 'malformed filter'), ('a\n1\n', ('--where', 'b=1'), 'unknown column'), ('a\n1\n', ('--sum', 'a'), 'require'), ('a\n1\n', ('--output', 'xml'), 'invalid choice'), ('a\n1\n', ('--group-by', 'b'), 'unknown column')]
        for text, args, expected in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertEqual(result.stdout, '')
        for value in ('', 'abc', 'NaN', 'Infinity'):
            result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--sum', 'n')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("row 2, column 'n'", result.stderr)


if __name__ == '__main__':
    unittest.main()
