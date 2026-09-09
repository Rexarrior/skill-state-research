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
    def run_cli(self, text, *args, ok=True):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            source = Path(directory) / 'input.csv'
            original = text.encode('utf-8')
            source.write_bytes(original)
            result = subprocess.run([sys.executable, str(ROOT / 'main.py'), str(source), *args],
                                    capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), original)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, '')
        return result

    def test_quoted_multiline_and_filters(self):
        text = 'id,note,status\r\n1,"hello,\r\nworld",yes\r\n2,a=b,yes\r\n3,a=b,no\r\n'
        rows = json.loads(self.run_cli(text).stdout)
        self.assertEqual(rows[0]['note'], 'hello,\r\nworld')
        result = self.run_cli(text, '--where', 'note=a=b', '--where', 'status=yes')
        self.assertEqual([r['id'] for r in json.loads(result.stdout)], ['2'])
        output = self.run_cli(text, '--output', 'csv').stdout
        self.assertEqual(list(csv.DictReader(io.StringIO(output)))[1], rows[1])

    def test_aggregates(self):
        text = 'g,x,y\nb,0.1,1\na,2.50,3\nb,0.2,2\na,-.50,7\n'
        rows = json.loads(self.run_cli(text, '--group-by', 'g', '--sum', 'x', '--avg', 'y').stdout)
        self.assertEqual(rows, [{'g': 'a', 'sum_x': '2', 'avg_y': '5'},
                                {'g': 'b', 'sum_x': '0.3', 'avg_y': '1.5'}])
        rows = json.loads(self.run_cli(text, '--group-by', 'g', '--sum', 'x', '--avg', 'x').stdout)
        self.assertEqual(rows[1]['avg_x'], '0.15')

    def test_precision_and_zero(self):
        text = 'g,x\na,123456789012345678901234567890\na,0.01\nb,-0\n'
        rows = json.loads(self.run_cli(text, '--group-by', 'g', '--sum', 'x').stdout)
        self.assertEqual(rows[0]['sum_x'], '123456789012345678901234567890.01')
        self.assertEqual(rows[1]['sum_x'], '0')

    def test_empty_and_distinct(self):
        self.assertEqual(json.loads(self.run_cli('g,x\n').stdout), [])
        self.assertEqual(self.run_cli('g,x\n', '--output', 'csv').stdout, 'g,x\n')
        rows = json.loads(self.run_cli('g,x\nb,1\na,2\nb,3\n', '--group-by', 'g').stdout)
        self.assertEqual(rows, [{'g': 'a'}, {'g': 'b'}])

    def test_invalid_csv(self):
        for text in ('', ',x\n', 'x,x\n', 'x,y\n1\n', 'x\n1,2\n', 'x\n"unfinished', 'x\n"a"oops\n'):
            with self.subTest(text=text):
                self.run_cli(text, ok=False)

    def test_arguments(self):
        for args in (('--where', 'x'), ('--where', '=a'), ('--where', 'missing=a'),
                     ('--sum', 'x'), ('--avg', 'x'), ('--group-by', 'missing'),
                     ('--output', 'xml'), ('--unknown',), ('--group-by', 'x', '--sum', 'missing')):
            with self.subTest(args=args):
                self.run_cli('x\n1\n', *args, ok=False)

    def test_bad_numeric_cells(self):
        for cell in ('', 'oops', 'NaN', 'Infinity', '1_000'):
            with self.subTest(cell=cell):
                result = self.run_cli(f'g,x\na,{cell}\n', '--group-by', 'g', '--sum', 'x', ok=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'x'", result.stderr)

    def test_filtered_invalid_number_and_empty_filter(self):
        result = self.run_cli('g,x\na,invalid\n,1e-2\n', '--where', 'g=', '--group-by', 'g', '--sum', 'x')
        self.assertEqual(json.loads(result.stdout), [{'g': '', 'sum_x': '0.01'}])


if __name__ == '__main__':
    unittest.main()
