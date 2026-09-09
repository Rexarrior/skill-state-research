import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("main.py")


class CLITests(unittest.TestCase):
    def run_cli(self, content, *args):
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as directory:
            path = Path(directory) / "input.csv"
            data = content.encode("utf-8")
            path.write_bytes(data)
            result = subprocess.run([sys.executable, str(SCRIPT), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), data)
            return result

    def success(self, content, *args):
        result = self.run_cli(content, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_quoted_fields_and_order(self):
        self.assertEqual(self.success('name,note\r\n"a,b","line1\nline2"\r\nx,"say ""hi"""\r\n'),
                         [{"name": "a,b", "note": "line1\nline2"}, {"name": "x", "note": 'say "hi"'}])

    def test_filters(self):
        self.assertEqual(self.success('a,b\nx,\nx,y\nz,\n', '--where', 'a=x', '--where', 'b='),
                         [{"a": "x", "b": ""}])
        self.assertEqual(self.success('a\nx=y\n', '--where', 'a=x=y'), [{"a": "x=y"}])

    def test_aggregates(self):
        rows = self.success('g,n,m\nz,0.1,2\na,2e-2,3\nz,0.2,5\n',
                            '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(rows, [{"g": "a", "sum_n": "0.02", "avg_m": "3"},
                                {"g": "z", "sum_n": "0.3", "avg_m": "3.5"}])

    def test_precision_and_cancellation(self):
        big = '10000000000000000000000000000000000000000'
        rows = self.success(f'g,n\nx,{big}\nx,0.01\nx,-{big}\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(rows[0]['sum_n'], '0.01')
        rows = self.success('g,n\nx,0.1\nx,0.2\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(rows[0], {'g': 'x', 'sum_n': '0.3', 'avg_n': '0.15'})

    def test_csv_roundtrip(self):
        content = 'a,b\n"x,y","hello\nworld"\n'
        result = self.run_cli(content, '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(content))))

    def test_empty_results_and_groups(self):
        self.assertEqual(self.success('a,b\n'), [])
        result = self.run_cli('a,b\n', '--output', 'csv')
        self.assertEqual(result.stdout, 'a,b\n')
        self.assertEqual(self.success('a\nz\na\nz\n', '--group-by', 'a'), [{'a': 'a'}, {'a': 'z'}])
        self.assertEqual(self.success('a,b\n', '--group-by', 'a', '--sum', 'b'), [])

    def test_invalid_inputs(self):
        for content, args, message in [
            ('', [], 'headers'), ('a,\n', [], 'headers'), ('a,a\n', [], 'unique'),
            ('a,b\nx\n', [], 'row 2'), ('a\nx,y\n', [], 'row 2'),
            ('a\n"unfinished', [], 'malformed CSV'), ('a\n"x"junk\n', [], 'malformed CSV'),
            ('a\nx\n', ['--where', 'b=x'], 'unknown column'),
            ('a\nx\n', ['--where', 'a'], 'malformed filter'),
            ('a\nx\n', ['--where', '=x'], 'malformed filter'),
            ('a\nx\n', ['--sum', 'a'], 'require --group-by'),
            ('a\nx\n', ['--avg', 'a'], 'require --group-by'),
            ('a\nx\n', ['--output', 'xml'], 'invalid choice'),
            ('a\nx\n', ['--group-by', 'b'], 'unknown column'),
            ('a\nx\n', ['--group-by', 'a', '--sum', 'b'], 'unknown column'),
            ('sum_n,n\nx,1\n', ['--group-by', 'sum_n', '--sum', 'n'], 'collide'),
        ]:
            with self.subTest(content=content, args=args):
                result = self.run_cli(content, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numeric_and_filter_order(self):
        for value in ('', 'oops', 'NaN', 'Infinity', '1_000'):
            result = self.run_cli(f'g,n\nx,{value}\n', '--group-by', 'g', '--avg', 'n')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("row 2, column 'n'", result.stderr)
        self.assertEqual(self.success('g,n\nx,bad\ny,2\n', '--where', 'g=y', '--group-by', 'g', '--sum', 'n'),
                         [{'g': 'y', 'sum_n': '2'}])


if __name__ == '__main__':
    unittest.main()
