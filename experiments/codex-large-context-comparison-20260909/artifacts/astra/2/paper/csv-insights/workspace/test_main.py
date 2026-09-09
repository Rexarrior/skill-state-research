import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CLITests(unittest.TestCase):
    def run_cli(self, text, *arguments, success=True):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            source = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            source.write_bytes(original)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')),
                                     str(source), *arguments], capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), original)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, '')
        return result

    def test_quotes_newlines_order_and_csv(self):
        text = 'name,note\r\nAda,"a,b"\r\nBob,"first\nsecond ""quoted"""\r\n'
        expected = [{'name': 'Ada', 'note': 'a,b'}, {'name': 'Bob', 'note': 'first\nsecond "quoted"'}]
        self.assertEqual(json.loads(self.run_cli(text).stdout), expected)
        output = self.run_cli(text, '--output', 'csv').stdout
        self.assertEqual(list(csv.DictReader(io.StringIO(output, newline=''))), expected)

    def test_filters(self):
        text = 'a,b\nx,1\nx,2\ny,2\n,=\n'
        self.assertEqual(json.loads(self.run_cli(text, '--where', 'a=x', '--where', 'b=2').stdout), [{'a': 'x', 'b': '2'}])
        self.assertEqual(json.loads(self.run_cli(text, '--where', 'a=', '--where', 'b==').stdout), [{'a': '', 'b': '='}])
        self.assertEqual(json.loads(self.run_cli(text, '--group-by', 'a').stdout)[0], {'a': 'x', 'b': '1'})

    def test_aggregation(self):
        text = 'g,n,m\nb,0.1,1\na,2,2\nb,0.2,4\na,3,3\n'
        result = self.run_cli(text, '--group-by', 'g', '--sum', 'n', '--avg', 'm')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '5', 'avg_m': '2.5'}, {'g': 'b', 'sum_n': '0.3', 'avg_m': '2.5'}])
        result = self.run_cli(text, '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(json.loads(result.stdout)[1], {'g': 'b', 'sum_n': '0.3', 'avg_n': '0.15'})

    def test_precision(self):
        text = 'g,n\na,10000000000000000000000000000\na,0.01\na,-10000000000000000000000000000\n'
        result = self.run_cli(text, '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_n': '0.01', 'avg_n': '0.003333333333333333333333333333'}])
        result = self.run_cli('g,n\na,1E-2\na,-0\n', '--group-by', 'g', '--avg', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['avg_n'], '0.005')

    def test_empty_results(self):
        self.assertEqual(json.loads(self.run_cli('g,n\n', '--group-by', 'g', '--sum', 'n').stdout), [])
        self.assertEqual(self.run_cli('g,n\n', '--group-by', 'g', '--avg', 'n', '--output', 'csv').stdout, 'g,avg_n\n')

    def test_invalid_input(self):
        for text in ['', ',b\n', 'a,a\n', 'a,b\n1\n', 'a\n1,2\n', 'a\n"unclosed\n', 'a\n"x"oops\n']:
            with self.subTest(text=text):
                self.run_cli(text, success=False)

    def test_invalid_arguments(self):
        for arguments in [('--where', 'a'), ('--where', '=x'), ('--where', 'missing=x'), ('--sum', 'a'), ('--avg', 'a'), ('--group-by', 'missing'), ('--output', 'xml'), ('--wat',), ('--group-by', 'a', '--avg', 'missing')]:
            with self.subTest(arguments=arguments):
                self.run_cli('a\n1\n', *arguments, success=False)

    def test_invalid_numbers(self):
        for cell in ['', 'abc', 'NaN', 'Infinity', '-Infinity', 'sNaN', '   ']:
            with self.subTest(cell=cell):
                result = self.run_cli('g,n\na,' + cell + '\n', '--group-by', 'g', '--sum', 'n', success=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'n'", result.stderr)
        self.assertEqual(json.loads(self.run_cli('g,n\na,bad\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'n').stdout), [])
        self.run_cli('g,n\na,1,extra\n', '--where', 'g=b', success=False)


if __name__ == '__main__':
    unittest.main()
