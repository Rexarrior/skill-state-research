import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('main.py')


class CliTests(unittest.TestCase):
    def run_cli(self, text, *args):
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as directory:
            path = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(SCRIPT), str(path), *args], capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
            return result

    def success(self, text, *args):
        result = self.run_cli(text, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_quoted_fields_and_order(self):
        self.assertEqual(self.success('name,note\r\n"a,b","line1\nline2"\r\nz,"say ""hi"""\r\n'),
                         [{'name': 'a,b', 'note': 'line1\nline2'}, {'name': 'z', 'note': 'say "hi"'}])

    def test_and_filters_and_equals(self):
        text = 'a,b\nx,1\nx,2\ny,2\nx,a=b\nx,\n'
        self.assertEqual(self.success(text, '--where', 'a=x', '--where', 'b=2'), [{'a': 'x', 'b': '2'}])
        self.assertEqual(self.success(text, '--where', 'b=a=b'), [{'a': 'x', 'b': 'a=b'}])
        self.assertEqual(self.success(text, '--where', 'b='), [{'a': 'x', 'b': ''}])

    def test_aggregates(self):
        text = 'g,x,y\nb,0.1,1\na,2,4\nb,0.2,2\na,3,5\n'
        self.assertEqual(self.success(text, '--group-by', 'g', '--sum', 'x', '--avg', 'y'),
                         [{'g': 'a', 'sum_x': '5', 'avg_y': '4.5'}, {'g': 'b', 'sum_x': '0.3', 'avg_y': '1.5'}])
        self.assertEqual(self.success(text, '--group-by', 'g'), self.success(text))

    def test_exact_large_sum_and_minimal_decimals(self):
        text = 'g,x\na,1000000000000000000000000000000\na,0.01\nb,-0.00\nc,2.5000\n'
        self.assertEqual(self.success(text, '--group-by', 'g', '--sum', 'x'),
                         [{'g': 'a', 'sum_x': '1000000000000000000000000000000.01'}, {'g': 'b', 'sum_x': '0'}, {'g': 'c', 'sum_x': '2.5'}])

    def test_same_column_and_repeating_average(self):
        self.assertEqual(self.success('g,x\na,1\na,0\na,0\n', '--group-by', 'g', '--sum', 'x', '--avg', 'x'),
                         [{'g': 'a', 'sum_x': '1', 'avg_x': '0.3333333333333333333333333333'}])

    def test_csv_and_empty_results(self):
        text = 'a,b\n"x,y","a\nb"\n'
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [['a', 'b'], ['x,y', 'a\nb']])
        self.assertEqual(self.run_cli(text, '--where', 'a=no', '--output', 'csv').stdout, 'a,b\n')
        self.assertEqual(self.success('a,b\n', '--group-by', 'a', '--sum', 'b'), [])

    def test_invalid_input(self):
        for text in ['', ',b\n', 'a,a\n', 'a,b\n1\n', 'a,b\n1,2,3\n', 'a\n"unclosed', 'a\nab"cd\n', 'a\n"x"y\n']:
            with self.subTest(text=text):
                result = self.run_cli(text)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)
                self.assertEqual(result.stdout, '')

    def test_invalid_numbers(self):
        for value in ['', 'oops', 'NaN', 'Infinity', '1_000']:
            with self.subTest(value=value):
                result = self.run_cli(f'g,x\na,{value}\n', '--group-by', 'g', '--sum', 'x')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'x'", result.stderr)
        self.assertEqual(self.success('g,x\na,bad\nb,1e-2\n', '--where', 'g=b', '--group-by', 'g', '--avg', 'x'), [{'g': 'b', 'avg_x': '0.01'}])

    def test_invalid_arguments(self):
        for args in [('--sum', 'b'), ('--avg', 'b'), ('--where', 'a'), ('--where', '=x'), ('--where', 'z=x'), ('--group-by', 'z'), ('--group-by', 'a', '--avg', 'z'), ('--output', 'xml'), ('--bogus',)]:
            with self.subTest(args=args):
                result = self.run_cli('a,b\n', *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr)

    def test_bom_and_output_collision(self):
        self.assertEqual(self.success('\ufeffa,b\nx,y\n'), [{'a': 'x', 'b': 'y'}])
        result = self.run_cli('sum_x,x\na,1\n', '--group-by', 'sum_x', '--sum', 'x')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('conflicts', result.stderr)


if __name__ == '__main__':
    unittest.main()
