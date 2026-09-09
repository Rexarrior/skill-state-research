import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MAIN = Path(__file__).resolve().with_name("main.py")


class CliTests(unittest.TestCase):
    def run_csv(self, content, *args, ok=True):
        with tempfile.TemporaryDirectory(dir=MAIN.parent) as directory:
            path = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(MAIN), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, "")
        return result

    def test_quoted_csv_and_order(self):
        data = 'name,note\r\n"A, B","line 1\nline 2"\r\nC,"say ""hi"""\r\n'
        rows = json.loads(self.run_csv(data).stdout)
        self.assertEqual(rows, [{"name": "A, B", "note": "line 1\nline 2"},
                                {"name": "C", "note": 'say "hi"'}])
        output = self.run_csv(data, "--output", "csv").stdout
        self.assertEqual(list(csv.DictReader(io.StringIO(output))), rows)

    def test_filters(self):
        data = 'a,b\nx,\nx,a=b\ny,a=b\n'
        self.assertEqual(json.loads(self.run_csv(data, '--where', 'a=x', '--where', 'b=a=b').stdout),
                         [{'a': 'x', 'b': 'a=b'}])
        self.assertEqual(json.loads(self.run_csv(data, '--where', 'b=').stdout), [{'a': 'x', 'b': ''}])

    def test_aggregation(self):
        data = 'g,n,m\nz,0.1,1\na,1e-2,2\nz,0.2,4\n'
        rows = json.loads(self.run_csv(data, '--group-by', 'g', '--sum', 'n', '--avg', 'm').stdout)
        self.assertEqual(rows, [{'g': 'a', 'sum_n': '0.01', 'avg_m': '2'},
                                {'g': 'z', 'sum_n': '0.3', 'avg_m': '2.5'}])

    def test_large_exact_sum(self):
        data = 'g,n\nx,10000000000000000000000000000\nx,0.01\nx,-10000000000000000000000000000\n'
        self.assertEqual(json.loads(self.run_csv(data, '--group-by', 'g', '--sum', 'n').stdout),
                         [{'g': 'x', 'sum_n': '0.01'}])

    def test_group_only_and_empty(self):
        self.assertEqual(json.loads(self.run_csv('g\nz\na\nz\n', '--group-by', 'g').stdout),
                         [{'g': 'a'}, {'g': 'z'}])
        self.assertEqual(self.run_csv('g,n\n', '--group-by', 'g', '--sum', 'n', '--output', 'csv').stdout,
                         'g,sum_n\n')
        self.assertEqual(json.loads(self.run_csv('g,n\nx,1\n', '--where', 'g=z').stdout), [])

    def test_bad_headers_and_rows(self):
        for data in ('', '\n', 'a,\n', 'a,a\n', 'a,b\nx\n', 'a\nx,y\n', 'a\n\n', 'a\n"open\n', 'a\n"x"oops\n'):
            with self.subTest(data=data):
                self.run_csv(data, ok=False)

    def test_bad_arguments(self):
        for args in (('--sum', 'n'), ('--avg', 'n'), ('--output', 'xml'), ('--unknown',),
                     ('--where', 'bad'), ('--where', '=x'), ('--where', 'missing=x'),
                     ('--group-by', 'missing'), ('--group-by', 'g', '--sum', 'missing')):
            with self.subTest(args=args):
                self.run_csv('g,n\nx,1\n', *args, ok=False)

    def test_bad_numbers(self):
        for value in ('', ' ', 'abc', 'NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value):
                result = self.run_csv(f'g,n\nx,{value}\n', '--group-by', 'g', '--avg', 'n', ok=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_filtered_numeric_validation(self):
        self.assertEqual(json.loads(self.run_csv('g,n\nx,bad\ny,2\n', '--where', 'g=y',
                                                '--group-by', 'g', '--sum', 'n').stdout),
                         [{'g': 'y', 'sum_n': '2'}])
        self.run_csv('g,n\nx,bad,extra\n', '--where', 'g=y', ok=False)

    def test_bom_and_zero(self):
        self.assertEqual(json.loads(self.run_csv('\ufeffg,n\nx,-0.00\n', '--group-by', 'g', '--sum', 'n').stdout),
                         [{'g': 'x', 'sum_n': '0'}])

    def test_output_column_collision(self):
        self.run_csv('sum_n,n\nx,1\n', '--group-by', 'sum_n', '--sum', 'n', ok=False)

    def test_missing_file(self):
        result = subprocess.run([sys.executable, str(MAIN), str(MAIN.parent / 'does-not-exist.csv')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('error:', result.stderr)


if __name__ == '__main__':
    unittest.main()
