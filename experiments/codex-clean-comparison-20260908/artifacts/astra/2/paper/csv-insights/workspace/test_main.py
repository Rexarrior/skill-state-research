import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class CLITests(unittest.TestCase):
    def run_cli(self, text, *args):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            source = Path(directory) / 'input.csv'
            source.write_bytes(text.encode())
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('main.py')),
                                     str(source), *args], capture_output=True, text=True)
            self.assertEqual(source.read_bytes(), text.encode())
            return result

    def test_quotes_filters_and_order(self):
        result = self.run_cli('g,n,note\r\nb,1,"a,b"\r\na,2,"two\nlines"\r\na,3,x=y\r\n',
                              '--where', 'g=a')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [dict(g='a', n='2', note='two\nlines'),
                                                    dict(g='a', n='3', note='x=y')])
        result = self.run_cli('a,b\nx,x=y\nx,z\ny,x=y\n', '--where', 'a=x', '--where', 'b=x=y')
        self.assertEqual(json.loads(result.stdout), [dict(a='x', b='x=y')])

    def test_aggregates(self):
        result = self.run_cli('g,n\nb,0.1\na,2\nb,0.2\na,3\n', '--group-by', 'g', '--sum', 'n', '--avg', 'n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [dict(g='a', sum_n='5', avg_n='2.5'),
                                                    dict(g='b', sum_n='0.3', avg_n='0.15')])
        result = self.run_cli('g,n\na,1000000000000000000000000000000\na,0.01\na,-1000000000000000000000000000000\n',
                              '--group-by', 'g', '--sum', 'n')
        self.assertEqual(json.loads(result.stdout)[0]['sum_n'], '0.01')

    def test_csv_and_empty_results(self):
        text = 'a,b\n"x,y","two\nlines"\n'
        result = self.run_cli(text, '--output', 'csv')
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), list(csv.reader(io.StringIO(text))))
        result = self.run_cli(text, '--where', 'a=absent', '--output', 'csv')
        self.assertEqual(result.stdout, 'a,b\n')
        result = self.run_cli('g,n\nb,1\na,2\nb,3\n', '--group-by', 'g')
        self.assertEqual(json.loads(result.stdout), [{'g': 'a'}, {'g': 'b'}])

    def test_errors(self):
        cases = [('', (), 'headers'), ('a,a\n1,2\n', (), 'unique'),
                 ('a,\n1,2\n', (), 'non-empty'), ('a,b\n1\n', (), 'row 2'),
                 ('a\n"unfinished', (), 'malformed CSV'),
                 ('a\nx\n', ('--where', 'missing=x'), 'unknown column'),
                 ('a\nx\n', ('--where', 'oops'), 'malformed filter'),
                 ('a\nx\n', ('--sum', 'a'), 'require --group-by'),
                 ('a\nx\n', ('--output', 'xml'), 'invalid choice')]
        for numeric in ('', 'bad', 'NaN', 'Infinity'):
            cases.append((f'g,n\na,{numeric}\n', ('--group-by', 'g', '--sum', 'n'), "row 2, column 'n'"))
        for text, args, message in cases:
            with self.subTest(text=text, args=args):
                result = self.run_cli(text, *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
