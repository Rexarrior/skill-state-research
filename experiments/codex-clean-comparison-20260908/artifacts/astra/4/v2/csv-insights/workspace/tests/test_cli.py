import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CLITests(unittest.TestCase):
    def run_cli(self, text, *args):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(ROOT / 'main.py'), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def test_quoted_fields_and_order(self):
        text = 'name,note\r\n"Doe, Jane","first\r\nsecond"\r\nBob,"said ""hi"""\r\n'
        expected = [{'name': 'Doe, Jane', 'note': 'first\r\nsecond'}, {'name': 'Bob', 'note': 'said "hi"'}]
        self.assertEqual(self.success(text), expected)
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        # subprocess text mode normalizes CRLF, including inside quoted fields.
        self.assertEqual(list(csv.DictReader(io.StringIO(result.stdout))), [dict(row, note=row['note'].replace('\r\n', '\n')) for row in expected])

    def test_filters(self):
        self.assertEqual(self.success('a,b\nx,1\nx,2\ny,2\n', '--where', 'a=x', '--where', 'b=2'), [{'a': 'x', 'b': '2'}])
        self.assertEqual(self.success('a,b\na=b,\nx,z\n', '--where', 'a=a=b', '--where', 'b='), [{'a': 'a=b', 'b': ''}])

    def test_aggregates(self):
        self.assertEqual(self.success('g,x,y\nz,0.1,1\na,1e-2,3\nz,0.2,2\n', '--group-by', 'g', '--sum', 'x', '--avg', 'y'), [{'g': 'a', 'sum_x': '0.01', 'avg_y': '3'}, {'g': 'z', 'sum_x': '0.3', 'avg_y': '1.5'}])
        self.assertEqual(self.success('g,x\na,-0.0\na,0\n', '--group-by', 'g', '--sum', 'x', '--avg', 'x'), [{'g': 'a', 'sum_x': '0', 'avg_x': '0'}])

    def test_precision_and_repeating_average(self):
        value = '123456789012345678901234567890'
        result = self.success(f'g,x\na,{value}\na,0.01\n', '--group-by', 'g', '--sum', 'x')
        self.assertEqual(result[0]['sum_x'], value + '.01')
        result = self.success('g,x\na,1\na,0\na,0\n', '--group-by', 'g', '--avg', 'x')
        self.assertEqual(result[0]['avg_x'], '0.' + '3' * 28)

    def test_group_only_and_empty(self):
        self.assertEqual(self.success('g\nz\na\nz\n', '--group-by', 'g'), [{'g': 'a'}, {'g': 'z'}])
        self.assertEqual(self.success('g,x\n', '--group-by', 'g', '--avg', 'x'), [])
        self.assertEqual(self.run_cli('g,x\na,1\n', '--where', 'g=z', '--output', 'csv').stdout, 'g,x\n')
        self.assertEqual(self.success('\ufeffa\nhello\n'), [{'a': 'hello'}])

    def test_validation(self):
        cases = [('', (), 'header'), ('a,\n', (), 'header'), ('a,a\n', (), 'duplicate'), ('a,b\n1\n', (), 'row 2'), ('a\n1,2\n', (), 'row 2'), ('a\n"open\n', (), 'malformed CSV'), ('a\n"x"junk\n', (), 'malformed CSV'), ('a\nx\n', ('--where', 'oops'), 'filter'), ('a\nx\n', ('--where', '=x'), 'filter'), ('a\nx\n', ('--where', 'b=x'), 'unknown column'), ('a\nx\n', ('--group-by', 'b'), 'unknown column'), ('a\nx\n', ('--group-by', 'a', '--sum', 'b'), 'unknown column'), ('a\nx\n', ('--avg', 'a'), 'require'), ('a\nx\n', ('--sum', 'a'), 'require'), ('a\nx\n', ('--output', 'xml'), 'invalid choice'), ('a\nx\n', ('--bogus',), 'unrecognized'), ('sum_x,x\na,1\n', ('--group-by', 'sum_x', '--sum', 'x'), 'conflicts')]
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numeric(self):
        for value in ('', ' ', 'bad', 'NaN', 'Infinity', '1_000'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,x\na,{value}\n', '--group-by', 'g', '--sum', 'x')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'x'", result.stderr)
        self.assertEqual(self.success('g,x\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'x'), [{'g': 'b', 'sum_x': '2'}])

    def test_io_errors(self):
        result = subprocess.run([sys.executable, str(ROOT / 'main.py'), str(ROOT / 'missing.csv')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('error:', result.stderr)
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
