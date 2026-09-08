import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def run_cli(self, content, *args):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("main.py")), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def test_quotes_newlines_and_filters(self):
        result = self.run_cli('name,status,note\r\n"Doe, Jane",yes,"a\nb"\r\nJohn,no,x\r\nJane,yes,z\r\n', '--where', 'status=yes', '--where', 'note=a\nb')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'name': 'Doe, Jane', 'status': 'yes', 'note': 'a\nb'}])

    def test_decimal_aggregation(self):
        result = self.run_cli('g,x,y\nb,0.1,2\na,1e-2,3\nb,0.2,5\n', '--group-by', 'g', '--sum', 'x', '--avg', 'y')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_x': '0.01', 'avg_y': '3'}, {'g': 'b', 'sum_x': '0.3', 'avg_y': '3.5'}])

    def test_large_exact_sum_and_negative_zero(self):
        value = '123456789012345678901234567890'
        result = self.run_cli(f'g,x\na,{value}\na,0.01\nb,-0.00\n', '--group-by', 'g', '--sum', 'x')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_x': value + '.01'}, {'g': 'b', 'sum_x': '0'}])

    def test_csv_roundtrip(self):
        result = self.run_cli('a,b\n"x,y","he said ""hi""\nagain"\n', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['a', 'b'], ['x,y', 'he said "hi"\nagain']])

    def test_empty_and_group_only(self):
        self.assertEqual(json.loads(self.run_cli('a,b\n').stdout), [])
        self.assertEqual(self.run_cli('a,b\n', '--output', 'csv').stdout, 'a,b\n')
        self.assertEqual(json.loads(self.run_cli('g\nz\na\nz\n', '--group-by', 'g').stdout), [{'g': 'a'}, {'g': 'z'}])

    def test_filter_equal_and_empty(self):
        result = self.run_cli('a,b\nx=y,\nx=z,1\n', '--where', 'a=x=y', '--where', 'b=')
        self.assertEqual(json.loads(result.stdout), [{'a': 'x=y', 'b': ''}])

    def test_errors(self):
        cases = [('', (), 'header'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'), ('a,b\nx\n', (), 'row 2'), ('a\n"unfinished', (), 'malformed CSV'), ('a\nx\n', ('--where', 'a'), 'malformed filter'), ('a\nx\n', ('--where', 'z=x'), 'unknown column'), ('a\nx\n', ('--sum', 'a'), 'require'), ('a\nx\n', ('--output', 'xml'), 'invalid choice'), ('a\nx\n', ('--bogus',), 'unrecognized'), ('g,x\na,\n', ('--group-by', 'g', '--sum', 'x'), "row 2, column 'x'"), ('g,x\na,NaN\n', ('--group-by', 'g', '--avg', 'x'), 'invalid numeric')]
        for content, args, message in cases:
            with self.subTest(content=content, args=args):
                result = self.run_cli(content, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_filter_before_numeric_validation(self):
        result = self.run_cli('g,x\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'x', '--avg', 'x')
        self.assertEqual(json.loads(result.stdout), [{'g': 'b', 'sum_x': '2', 'avg_x': '2'}])
        result = self.run_cli('g,x\na,bad,extra\nb,2\n', '--where', 'g=b')
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
