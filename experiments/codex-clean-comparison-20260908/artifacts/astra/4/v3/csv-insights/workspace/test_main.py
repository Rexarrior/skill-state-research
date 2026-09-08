"""End-to-end tests using only the standard library."""
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
    def run_cli(self, text, *args):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "input.csv"
            original = text.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(ROOT / "main.py"), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_quotes_newlines_filters_and_order(self):
        text = 'name,status,note\r\n"A, B",yes,"one\r\ntwo"\r\nC,no,x\r\nD,yes,a=b\r\n'
        rows = json.loads(self.success(text, '--where', 'status=yes'))
        self.assertEqual([row['name'] for row in rows], ['A, B', 'D'])
        self.assertEqual(rows[0]['note'], 'one\r\ntwo')
        self.assertEqual(json.loads(self.success(text, '--where', 'status=yes', '--where', 'note=a=b')), [rows[1]])

    def test_aggregates_sorted_and_exact(self):
        text = 'g,x,y\nz,0.1,1\na,2,2\nz,0.2,4\na,3,3\n'
        self.assertEqual(json.loads(self.success(text, '--group-by', 'g', '--sum', 'x', '--avg', 'y')), [
            {'g': 'a', 'sum_x': '5', 'avg_y': '2.5'}, {'g': 'z', 'sum_x': '0.3', 'avg_y': '2.5'}])
        text = 'g,x\na,1000000000000000000000000000000\na,0.01\na,-1000000000000000000000000000000\n'
        self.assertEqual(json.loads(self.success(text, '--group-by', 'g', '--sum', 'x'))[0]['sum_x'], '0.01')

    def test_csv_roundtrip(self):
        text = 'g,x\n"a,b",1.20\n"a,b",1.30\n'
        output = self.success(text, '--group-by', 'g', '--sum', 'x', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(output))), [['g', 'sum_x'], ['a,b', '2.5']])
        text = 'a,b\n"hello, world","a\nb"\n'
        self.assertEqual(list(csv.reader(io.StringIO(self.success(text, '--output', 'csv')))), list(csv.reader(io.StringIO(text))))

    def test_empty_and_group_only(self):
        self.assertEqual(json.loads(self.success('g,x\n')), [])
        self.assertEqual(self.success('g,x\na,1\n', '--where', 'g=b', '--output', 'csv'), 'g,x\n')
        self.assertEqual(json.loads(self.success('g,x\nb,1\na,2\nb,3\n', '--group-by', 'g')), [{'g': 'a'}, {'g': 'b'}])
        self.assertEqual(json.loads(self.success('g,x\na,\n', '--where', 'x=')), [{'g': 'a', 'x': ''}])

    def test_numeric_formats(self):
        rows = json.loads(self.success('g,x\na, 1e-2 \na,-0.0100\n', '--group-by', 'g', '--sum', 'x', '--avg', 'x'))
        self.assertEqual(rows, [{'g': 'a', 'sum_x': '0', 'avg_x': '0'}])
        row = json.loads(self.success('g,x\na,1\na,0\na,0\n', '--group-by', 'g', '--avg', 'x'))[0]
        self.assertEqual(row['avg_x'], '0.' + '3' * 28)

    def test_errors(self):
        cases = [('', [], 'header'), ('a,a\n', [], 'unique'), ('a,\n', [], 'non-empty'),
                 ('a,b\n1\n', [], 'row 2'), ('a\n1,2\n', [], 'row 2'),
                 ('a\n"unfinished', [], 'malformed CSV'), ('a\n"x"bad\n', [], 'malformed CSV'),
                 ('a\n1\n', ['--where', 'bad'], 'malformed filter'),
                 ('a\n1\n', ['--where', '=1'], 'malformed filter'),
                 ('a\n1\n', ['--where', 'b=1'], 'unknown column'),
                 ('a\n1\n', ['--group-by', 'b'], 'unknown column'),
                 ('a\n1\n', ['--sum', 'a'], 'require --group-by'),
                 ('a\n1\n', ['--avg', 'a'], 'require --group-by'),
                 ('a\n1\n', ['--output', 'xml'], 'invalid choice'),
                 ('a\n1\n', ['--wat'], 'unrecognized arguments')]
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numbers_and_filtered_rows(self):
        for value in ('', 'abc', 'NaN', 'Infinity', '1_000'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,x\na,{value}\n', '--group-by', 'g', '--avg', 'x')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'x'", result.stderr)
        self.assertEqual(json.loads(self.success('g,x\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'x')), [{'g': 'b', 'sum_x': '2'}])
        result = self.run_cli('g,x\na,bad,extra\n', '--where', 'g=b')
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
