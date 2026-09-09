"""End-to-end CLI tests; temporary inputs stay inside the project directory."""

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
    def run_cli(self, content, *args):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            source = Path(directory) / "input.csv"
            original = content.encode("utf-8")
            source.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *args],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(source.read_bytes(), original, "input was modified")
            return result

    def success(self, content, *args):
        result = self.run_cli(content, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout

    def failure(self, content, args, message):
        result = self.run_cli(content, *args)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_csv_quoting_and_order(self):
        content = 'name,note\r\n"Doe, Jane","hello\r\nworld"\r\nBob,"said ""yes"""\r\n'
        result = json.loads(self.success(content))
        self.assertEqual(result, [
            {"name": "Doe, Jane", "note": "hello\r\nworld"},
            {"name": "Bob", "note": 'said "yes"'},
        ])
        output = self.success(content, "--output", "csv")
        # subprocess universal newlines normalize CRLF, including inside cells.
        self.assertEqual(list(csv.reader(io.StringIO(output))),
                         [["name", "note"], ["Doe, Jane", "hello\nworld"], ["Bob", 'said "yes"']])

    def test_filters_and_exact_strings(self):
        content = 'a,b\nx,1\nx,01\ny,1\nx,1\n'
        self.assertEqual(json.loads(self.success(content, "--where", "a=x", "--where", "b=1")),
                         [{"a": "x", "b": "1"}, {"a": "x", "b": "1"}])
        self.assertEqual(json.loads(self.success('a,b\nx,\nx,a=b\n', "--where", "b=")),
                         [{"a": "x", "b": ""}])
        self.assertEqual(json.loads(self.success('a,b\nx,a=b\n', "--where", "b=a=b")),
                         [{"a": "x", "b": "a=b"}])

    def test_aggregates(self):
        content = 'g,x,y\nz,0.1,1\na,2.00,3\nz,0.2,2\na,3,4\n'
        self.assertEqual(json.loads(self.success(content, "--group-by", "g", "--sum", "x", "--avg", "y")),
                         [{"g": "a", "sum_x": "5", "avg_y": "3.5"},
                          {"g": "z", "sum_x": "0.3", "avg_y": "1.5"}])
        output = self.success(content, "--group-by", "g", "--sum", "x", "--avg", "x", "--output", "csv")
        self.assertEqual(list(csv.reader(io.StringIO(output))),
                         [["g", "sum_x", "avg_x"], ["a", "5", "2.5"], ["z", "0.3", "0.15"]])

    def test_decimal_precision(self):
        self.assertEqual(json.loads(self.success(
            'g,x\na,123456789012345678901234567890\na,0.01\n',
            "--group-by", "g", "--sum", "x"))[0]["sum_x"],
            "123456789012345678901234567890.01")
        self.assertEqual(json.loads(self.success('g,x\na,1\na,0\na,0\n',
                         "--group-by", "g", "--avg", "x"))[0]["avg_x"],
                         "0.3333333333333333333333333333")
        self.assertEqual(json.loads(self.success('g,x\na,-0.000\nb,1E-2\n',
                         "--group-by", "g", "--sum", "x")),
                         [{"g": "a", "sum_x": "0"}, {"g": "b", "sum_x": "0.01"}])

    def test_group_only_and_empty_results(self):
        self.assertEqual(json.loads(self.success('g\nz\na\nz\n', "--group-by", "g")),
                         [{"g": "a"}, {"g": "z"}])
        self.assertEqual(json.loads(self.success('g,x\n', "--group-by", "g", "--sum", "x")), [])
        self.assertEqual(self.success('g,x\na,1\n', "--where", "g=z", "--output", "csv"), 'g,x\n')
        self.assertEqual(self.success('g,x\n', "--group-by", "g", "--avg", "x", "--output", "csv"),
                         'g,avg_x\n')

    def test_invalid_headers_and_rows(self):
        for content, message in [('', 'header'), ('\n', 'header'), ('a,\n', 'non-empty'),
                                 ('a,a\n', 'unique'), ('a,b\n1\n', 'row 2'),
                                 ('a\n1,2\n', 'row 2'), ('a\n"unfinished', 'malformed CSV'),
                                 ('a\n"closed"junk\n', 'malformed CSV')]:
            with self.subTest(content=content):
                self.failure(content, [], message)
        self.failure('a,b\nx,1,2\n', ["--where", "a=z"], 'row 2')

    def test_invalid_numbers(self):
        for value in ['', ' ', 'abc', 'NaN', 'Infinity', '-Infinity', 'sNaN']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,x\na,{value}\n', "--group-by", "g", "--sum", "x")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'x'", result.stderr)
                self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(self.success('g,x\na,invalid\nb,2\n',
                         '--where', 'g=b', '--group-by', 'g', '--sum', 'x')),
                         [{"g": "b", "sum_x": "2"}])

    def test_invalid_arguments(self):
        for args, message in [(['--sum', 'x'], 'require --group-by'),
                              (['--avg', 'x'], 'require --group-by'),
                              (['--where', 'x'], 'malformed filter'),
                              (['--where', '=1'], 'malformed filter'),
                              (['--output', 'xml'], 'invalid choice'),
                              (['--bogus'], 'unrecognized arguments'),
                              (['--where'], 'expected one argument')]:
            with self.subTest(args=args):
                self.failure('g,x\na,1\n', args, message)

    def test_unknown_columns(self):
        for args in [['--where', 'missing=1'], ['--group-by', 'missing'],
                     ['--group-by', 'g', '--sum', 'missing'],
                     ['--group-by', 'g', '--avg', 'missing']]:
            with self.subTest(args=args):
                self.failure('g,x\n', args, 'unknown column')

    def test_output_collision(self):
        self.failure('sum_x,x\na,1\n', ['--group-by', 'sum_x', '--sum', 'x'], 'collide')

    def test_bom_and_unicode(self):
        self.assertEqual(json.loads(self.success('\ufeffcity\n東京\n')), [{"city": "東京"}])

    def test_missing_file(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            result = subprocess.run([sys.executable, str(ROOT / 'main.py'), str(Path(directory) / 'missing.csv')],
                                    capture_output=True, text=True, cwd=ROOT)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('error:', result.stderr)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
