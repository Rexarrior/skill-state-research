import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MAIN = Path(__file__).with_name("main.py")


class CLITests(unittest.TestCase):
    def run_cli(self, text, *args):
        with tempfile.TemporaryDirectory(dir=MAIN.parent) as directory:
            source = Path(directory) / "input.csv"
            original = text.encode("utf-8")
            source.write_bytes(original)
            result = subprocess.run([sys.executable, str(MAIN), str(source), *args], capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_quoted_and_multiline(self):
        text = 'name,note\r\n"a,b","line 1\nline ""2"""\r\n'
        expected = [{"name": "a,b", "note": 'line 1\nline "2"'}]
        self.assertEqual(json.loads(self.success(text)), expected)
        output = self.success(text, "--output", "csv")
        self.assertEqual(list(csv.DictReader(io.StringIO(output))), expected)

    def test_filters(self):
        text = 'a,b\nx,=z\nx,z\ny,=z\nx,=z\n'
        self.assertEqual(json.loads(self.success(text, '--where', 'a=x', '--where', 'b==z')),
                         [{'a': 'x', 'b': '=z'}] * 2)
        self.assertEqual(json.loads(self.success('a,b\nx,\nx,z\n', '--where', 'b=')), [{'a': 'x', 'b': ''}])

    def test_aggregates(self):
        text = 'g,x,y\nb,0.1,1\na,1e-2,2\nb,0.2,4\na,-0.01,3\n'
        self.assertEqual(json.loads(self.success(text, '--group-by', 'g', '--sum', 'x', '--avg', 'y')),
                         [{'g': 'a', 'sum_x': '0', 'avg_y': '2.5'}, {'g': 'b', 'sum_x': '0.3', 'avg_y': '2.5'}])

    def test_precision(self):
        text = 'g,x\na,123456789012345678901234567890\na,0.01\n'
        row = json.loads(self.success(text, '--group-by', 'g', '--sum', 'x', '--avg', 'x'))[0]
        self.assertEqual(row['sum_x'], '123456789012345678901234567890.01')
        self.assertEqual(row['avg_x'], '61728394506172839450617283945.005')
        self.assertEqual(json.loads(self.success('g,x\na,1\na,0\na,0\n', '--group-by', 'g', '--avg', 'x'))[0]['avg_x'], '0.3333333333333333333333333333')

    def test_distinct_and_empty(self):
        self.assertEqual(json.loads(self.success('g\nb\na\nb\n', '--group-by', 'g')), [{'g': 'a'}, {'g': 'b'}])
        self.assertEqual(json.loads(self.success('g,x\n', '--group-by', 'g', '--sum', 'x')), [])
        self.assertEqual(self.success('g,x\n', '--output', 'csv'), 'g,x\n')
        self.assertEqual(json.loads(self.success('\ufeffg,x\na,1\n', '--where', 'g=z')), [])

    def test_input_errors(self):
        cases = [('', (), 'headers'), ('a,\n', (), 'headers'), ('a,a\n', (), 'unique'),
                 ('a,b\nx\n', (), 'row 2'), ('a\nx,y\n', (), 'row 2'),
                 ('a\n"unfinished', (), 'CSV'), ('a\n"x"oops\n', (), 'CSV'),
                 ('a\nx\n', ('--where', 'a'), 'filter'),
                 ('a\nx\n', ('--where', '=x'), 'filter'),
                 ('a\nx\n', ('--where', 'b=x'), 'unknown column'),
                 ('a\nx\n', ('--group-by', 'b'), 'unknown column'),
                 ('a\nx\n', ('--group-by', 'a', '--sum', 'b'), 'unknown column'),
                 ('a\nx\n', ('--sum', 'a'), 'require'),
                 ('a\nx\n', ('--avg', 'a'), 'require'),
                 ('a\nx\n', ('--output', 'xml'), 'invalid choice'),
                 ('a\nx\n', ('--bad',), 'unrecognized'),
                 ('sum_x,x\na,1\n', ('--group-by', 'sum_x', '--sum', 'x'), 'collide'),
                 ('a,b\nx\n', ('--where', 'a=z'), 'row 2')]
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_numeric_errors(self):
        for value in ('', ' ', 'abc', 'NaN', 'Infinity', '1_000'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,x\na,{value}\n', '--group-by', 'g', '--sum', 'x')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'x'", result.stderr)
        self.assertEqual(json.loads(self.success('g,x\na,bad\nb,1\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'x')), [{'g': 'b', 'sum_x': '1'}])

    def test_missing_file(self):
        result = subprocess.run([sys.executable, str(MAIN), str(MAIN.parent / 'nonexistent.csv')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('error:', result.stderr)


if __name__ == '__main__':
    unittest.main()
