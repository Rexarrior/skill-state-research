import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


MAIN = Path(__file__).with_name("main.py")


class CLITests(unittest.TestCase):
    def run_cli(self, text, *args, ok=True):
        with tempfile.TemporaryDirectory(dir=MAIN.parent) as directory:
            path = Path(directory) / "input.csv"
            original = text.encode("utf-8")
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

    def test_quoted_csv_and_filters(self):
        text = 'id,note,kind\r\n1,"hello, world\nnext line",a\r\n2,x,b\r\n3,x,a\r\n'
        result = self.run_cli(text, '--where', 'kind=a')
        self.assertEqual(json.loads(result.stdout), [
            {'id': '1', 'note': 'hello, world\nnext line', 'kind': 'a'},
            {'id': '3', 'note': 'x', 'kind': 'a'}])
        result = self.run_cli(text, '--where', 'kind=a', '--where', 'note=x')
        self.assertEqual(json.loads(result.stdout)[0]['id'], '3')
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))),
                         list(csv.reader(io.StringIO(text))))

    def test_aggregates(self):
        result = self.run_cli('g,x,y\nb,0.1,1\na,1.00,4\nb,0.2,2\n',
                              '--group-by', 'g', '--sum', 'x', '--avg', 'y')
        self.assertEqual(json.loads(result.stdout), [
            {'g': 'a', 'sum_x': '1', 'avg_y': '4'},
            {'g': 'b', 'sum_x': '0.3', 'avg_y': '1.5'}])
        result = self.run_cli('g,x\na,10000000000000000000000000000\na,0.01\n',
                              '--group-by', 'g', '--sum', 'x')
        self.assertEqual(json.loads(result.stdout)[0]['sum_x'], '10000000000000000000000000000.01')
        result = self.run_cli('g,x\na,-0.00\na,0\n', '--group-by', 'g', '--sum', 'x', '--avg', 'x')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a', 'sum_x': '0', 'avg_x': '0'}])

    def test_empty_and_group_only(self):
        self.assertEqual(json.loads(self.run_cli('g,x\n', '--group-by', 'g', '--sum', 'x').stdout), [])
        self.assertEqual(self.run_cli('g,x\n', '--output', 'csv').stdout, 'g,x\n')
        self.assertEqual(json.loads(self.run_cli('g\nb\na\nb\n', '--group-by', 'g').stdout), [{'g': 'b'}, {'g': 'a'}, {'g': 'b'}])
        self.assertEqual(json.loads(self.run_cli('g,x\na,\na,a=b\n', '--where', 'x=a=b').stdout), [{'g': 'a', 'x': 'a=b'}])

    def test_invalid_inputs(self):
        for text in ('', ',b\n1,2\n', 'a,a\n1,2\n', 'a,b\n1\n', 'a\n1,2\n', 'a\n"unclosed', 'a\n"x"oops\n'):
            with self.subTest(text=text):
                self.run_cli(text, ok=False)
        for args in (('--where', 'bad'), ('--where', '=x'), ('--where', 'z=1'),
                     ('--sum', 'x'), ('--avg', 'x'), ('--group-by', 'z'),
                     ('--group-by', 'g', '--sum', 'z'), ('--output', 'xml'), ('--unknown',)):
            with self.subTest(args=args):
                self.run_cli('g,x\na,1\n', *args, ok=False)
        for number in ('', 'bad', 'NaN', 'Infinity', '-Infinity'):
            result = self.run_cli(f'g,x\na,{number}\n', '--group-by', 'g', '--sum', 'x', ok=False)
            self.assertIn('row 2', result.stderr)
            self.assertIn("column 'x'", result.stderr)

    def test_filtered_validation(self):
        self.run_cli('g,x\na,bad\nb,2\n', '--where', 'g=b', '--group-by', 'g', '--sum', 'x')
        self.run_cli('g,x\na\nb,2\n', '--where', 'g=b', ok=False)


if __name__ == '__main__':
    unittest.main()
