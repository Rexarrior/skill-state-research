import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


MAIN = Path(__file__).with_name('main.py').resolve()


class CLITests(unittest.TestCase):
    def run_cli(self, content, *args, success=True):
        with tempfile.TemporaryDirectory(dir=MAIN.parent) as directory:
            path = Path(directory) / 'input.csv'
            original = content.encode('utf-8')
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(MAIN), str(path), *args],
                                    capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), original)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, '')
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
            self.assertEqual(result.stdout, '')
        return result

    def test_quoted_records_filters_and_order(self):
        source = 'name,tag,note\r\n"A, B",x,"first\nsecond"\r\nC,x,a=b\r\nD,y,other\r\n'
        result = self.run_cli(source, '--where', 'tag=x')
        self.assertEqual(json.loads(result.stdout), [
            {'name': 'A, B', 'tag': 'x', 'note': 'first\nsecond'},
            {'name': 'C', 'tag': 'x', 'note': 'a=b'}])
        result = self.run_cli(source, '--where', 'tag=x', '--where', 'note=a=b')
        self.assertEqual(json.loads(result.stdout)[0]['name'], 'C')

    def test_decimal_aggregation(self):
        result = self.run_cli('g,x,y\nz,0.1,2\na,1e-2,5\nz,0.2,3\n',
                              '--group-by', 'g', '--sum', 'x', '--avg', 'y')
        self.assertEqual(json.loads(result.stdout), [
            {'g': 'a', 'sum_x': '0.01', 'avg_y': '5'},
            {'g': 'z', 'sum_x': '0.3', 'avg_y': '2.5'}])

    def test_large_sum_and_zero(self):
        result = self.run_cli('g,x\na,1000000000000000000000000000000\na,0.01\nb,-0\n',
                             '--group-by', 'g', '--sum', 'x')
        self.assertEqual(json.loads(result.stdout), [
            {'g': 'a', 'sum_x': '1000000000000000000000000000000.01'},
            {'g': 'b', 'sum_x': '0'}])

    def test_csv_round_trip(self):
        source = 'a,b\r\n"x,y","a""b\nc"\r\n'
        result = self.run_cli(source, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))),
                         list(csv.reader(io.StringIO(source))))

    def test_empty_and_group_only(self):
        self.assertEqual(json.loads(self.run_cli('g,x\n', '--group-by', 'g', '--sum', 'x').stdout), [])
        self.assertEqual(self.run_cli('g,x\n', '--output', 'csv').stdout, 'g,x\n')
        self.assertEqual(json.loads(self.run_cli('g\nz\na\nz\n', '--group-by', 'g').stdout),
                         [{'g': 'z'}, {'g': 'a'}, {'g': 'z'}])
        self.assertEqual(json.loads(self.run_cli('g,x\na,\nb,1\n', '--where', 'x=').stdout),
                         [{'g': 'a', 'x': ''}])

    def test_bad_csv(self):
        for source in ('', '\na,b\n', 'a,\n1,2\n', 'a,a\n1,2\n',
                       'a,b\n1\n', 'a\n1,2\n', 'a\n"unterminated', 'a\n"x"oops\n'):
            with self.subTest(source=source):
                self.run_cli(source, success=False)

    def test_bad_arguments(self):
        for args in (('--where', 'a'), ('--where', '=x'), ('--where', 'missing=x'),
                     ('--group-by', 'missing'), ('--sum', 'a'), ('--avg', 'a'),
                     ('--output', 'xml'), ('--unknown',), ('--where',),
                     ('--group-by', 'a', '--sum', 'missing')):
            with self.subTest(args=args):
                self.run_cli('a,b\n1,2\n', *args, success=False)

    def test_numeric_errors_and_filtering(self):
        for value in ('', 'oops', 'NaN', 'Infinity', '-Infinity'):
            with self.subTest(value=value):
                result = self.run_cli(f'g,x\na,{value}\n', '--group-by', 'g', '--avg', 'x', success=False)
                self.assertIn('row 2', result.stderr)
                self.assertIn("column 'x'", result.stderr)
        self.run_cli('g,x\na,oops\nb,1\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'x')
        self.run_cli('g,x\na,oops,extra\nb,1\n', '--where', 'g=b', success=False)

    def test_both_aggregates_and_name_collision(self):
        result = self.run_cli('g,x\na,1\na,2\n', '--group-by', 'g', '--sum', 'x', '--avg', 'x', '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))),
                         [['g', 'sum_x', 'avg_x'], ['a', '3', '1.5']])
        self.run_cli('sum_x,x\na,1\n', '--group-by', 'sum_x', '--sum', 'x', success=False)


if __name__ == '__main__':
    unittest.main()
