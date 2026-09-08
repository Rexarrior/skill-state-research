import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("main.py")


class CliTests(unittest.TestCase):
    def run_cli(self, content, *args, ok=True):
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as directory:
            source = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            source.write_bytes(original)
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), *args],
                                    capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), original)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, "")
        return result

    def test_quoted_multiline_and_order(self):
        data = 'id,note\r\n2,"hello, world"\r\n1,"two\nlines"\r\n'
        expected = [{"id": "2", "note": "hello, world"}, {"id": "1", "note": "two\nlines"}]
        self.assertEqual(json.loads(self.run_cli(data).stdout), expected)
        result = self.run_cli(data, "--output", "csv")
        self.assertEqual(list(csv.DictReader(io.StringIO(result.stdout))), expected)

    def test_filters(self):
        data = 'a,b\nx,a=b\nx,no\ny,a=b\n'
        result = self.run_cli(data, '--where', 'a=x', '--where', 'b=a=b')
        self.assertEqual(json.loads(result.stdout), [{'a': 'x', 'b': 'a=b'}])
        self.assertEqual(json.loads(self.run_cli(data, '--where', 'a=').stdout), [])

    def test_aggregates(self):
        data = 'g,x,y\nb,0.1,1\na,1.00,2\nb,0.2,4\na,2,3\n'
        result = self.run_cli(data, '--group-by', 'g', '--sum', 'x', '--avg', 'y')
        self.assertEqual(json.loads(result.stdout), [
            {'g': 'a', 'sum_x': '3', 'avg_y': '2.5'},
            {'g': 'b', 'sum_x': '0.3', 'avg_y': '2.5'}])

    def test_large_precision_and_zero(self):
        data = 'g,n\na,1000000000000000000000000000000\na,0.01\nb,-0.00\n'
        result = self.run_cli(data, '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [
            {'g': 'a', 'sum_n': '1000000000000000000000000000000.01'},
            {'g': 'b', 'sum_n': '0'}])

    def test_distinct_and_empty(self):
        self.assertEqual(json.loads(self.run_cli('g\nb\na\nb\n', '--group-by', 'g').stdout),
                         [{'g': 'a'}, {'g': 'b'}])
        self.assertEqual(self.run_cli('g,n\n', '--group-by', 'g', '--sum', 'n', '--output', 'csv').stdout,
                         'g,sum_n\n')

    def test_numeric_errors(self):
        for value in ('', 'no', 'NaN', 'Infinity', '1_000'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--sum', 'n', ok=False)
                self.assertIn("row 2, column 'n'", result.stderr)
        self.assertEqual(json.loads(self.run_cli('g,n\na,bad\n', '--where', 'g=b',
                                                '--group-by', 'g', '--sum', 'n').stdout), [])

    def test_invalid_inputs(self):
        for content in ('', ',b\n', 'a,a\n', 'a,b\n1\n', 'a\n1,2\n', 'a\n"unfinished', 'a\n"x"oops\n'):
            with self.subTest(content=content):
                self.run_cli(content, ok=False)

    def test_invalid_arguments(self):
        for args in (('--where', 'x'), ('--where', '=x'), ('--where', 'missing=x'),
                     ('--sum', 'a'), ('--avg', 'a'), ('--group-by', 'missing'),
                     ('--output', 'xml'), ('--unknown',), ('--group-by', 'a', '--sum', 'missing')):
            with self.subTest(args=args):
                self.run_cli('a\n1\n', *args, ok=False)

    def test_scientific_and_recurring_average(self):
        result = self.run_cli('g,n\na,1e-2\na,0\na,0\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        row = json.loads(result.stdout)[0]
        self.assertEqual(row['sum_n'], '0.01')
        self.assertEqual(row['avg_n'], '0.003333333333333333333333333333')


if __name__ == '__main__':
    unittest.main()
