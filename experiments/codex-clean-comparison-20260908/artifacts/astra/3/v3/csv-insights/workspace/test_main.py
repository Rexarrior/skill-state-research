import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def run_cli(self, content, *arguments):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            source = Path(directory) / 'input.csv'
            original = content.encode('utf-8')
            source.write_bytes(original)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')), str(source), *arguments], capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), original)
            return result

    def test_quoted_records_and_filters(self):
        result = self.run_cli('name,tag,note\r\n"Tea, green",x,"line one\nline two"\r\nOther,x,a=b\r\nOther,y,a=b\r\n', '--where', 'tag=x')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'name': 'Tea, green', 'tag': 'x', 'note': 'line one\nline two'}, {'name': 'Other', 'tag': 'x', 'note': 'a=b'}])
        result = self.run_cli('a,b\nx,a=b\nx,z\ny,a=b\n', '--where', 'a=x', '--where', 'b=a=b')
        self.assertEqual(json.loads(result.stdout), [{'a': 'x', 'b': 'a=b'}])

    def test_aggregates(self):
        result = self.run_cli('g,n,m\nb,0.1,1\na,2,4\nb,0.2,2\n', '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '2', 'avg_m': '4'}, {'g': 'b', 'sum_n': '0.3', 'avg_m': '1.5'}])

    def test_exact_large_sum_and_zero(self):
        result = self.run_cli('g,n\na,10000000000000000000000000000\na,0.01\nb,-0.00\n', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '10000000000000000000000000000.01'}, {'g': 'b', 'sum_n': '0'}])

    def test_csv_roundtrip(self):
        text = 'a,b\r\n"x,y","hello\n""world"""\r\n'
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(text))))

    def test_empty_and_group_only(self):
        self.assertEqual(json.loads(self.run_cli('a,b\n').stdout), [])
        self.assertEqual(self.run_cli('a,b\n', '--output', 'csv').stdout, 'a,b\n')
        self.assertEqual(json.loads(self.run_cli('a,b\nz,1\na,2\nz,3\n', '--group-by', 'a').stdout), [{'a': 'z', 'b': '1'}, {'a': 'a', 'b': '2'}, {'a': 'z', 'b': '3'}])

    def test_invalid_inputs(self):
        cases = [('', (), 'headers'), ('a,a\n', (), 'unique'), ('a,\n', (), 'non-empty'), ('a,b\nx\n', (), 'row 2'), ('a\n"unterminated', (), 'malformed CSV'), ('a\nx\n', ('--where', 'a'), 'malformed filter'), ('a\nx\n', ('--where', 'b=x'), 'unknown column'), ('a\nx\n', ('--sum', 'a'), 'require'), ('a\nx\n', ('--group-by', 'b'), 'unknown column'), ('a\nx\n', ('--output', 'xml'), 'invalid choice')]
        for content, arguments, message in cases:
            with self.subTest(content=content, arguments=arguments):
                result = self.run_cli(content, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numbers(self):
        for value in ['', 'hello', 'NaN', 'Infinity']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,n\na,{value}\n', '--group-by', 'g', '--avg', 'n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)

    def test_filtered_numeric_validation(self):
        result = self.run_cli('g,n\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'b', 'sum_n': '2'}])


if __name__ == '__main__':
    unittest.main()
