import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def run_cli(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filtering_preserves_quoted_fields_and_order(self):
        result = self.run_cli(
            'name,team,note\r\nAlice,A,"hello, world"\r\nBob,B,"two\nlines"\r\n',
            "--where",
            "team=B",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "team": "B", "note": "two\nlines"}],
        )

    def test_sum_and_average_are_sorted_and_minimal(self):
        result = self.run_cli(
            "group,amount,count\r\nz,0.10,2\r\na,1.20,2\r\na,1.30,3\r\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "count",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "2.5", "avg_count": "2.5"},
                {"group": "z", "sum_amount": "0.1", "avg_count": "2"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.run_cli('name,note\r\nA,"x,y"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["name", "note"], ["A", "x,y"]])
        self.assertIn('"x,y"', result.stdout)

    def test_multiple_filters_use_and_and_allow_equals_in_value(self):
        result = self.run_cli(
            "a,b\r\nx,1=2\r\nx,no\r\ny,1=2\r\n",
            "--where",
            "a=x",
            "--where",
            "b=1=2",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "x", "b": "1=2"}])

    def test_bad_shape_and_headers_are_errors(self):
        for content, expected in (
            ("a,a\r\n1,2\r\n", "duplicate"),
            ("a,\r\n1,2\r\n", "empty column"),
            ("a,b\r\n1\r\n", "expected 2 fields"),
        ):
            with self.subTest(content=content):
                result = self.run_cli(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)

    def test_numeric_and_argument_errors_are_useful(self):
        cases = (
            (("--sum", "amount"), "require --group-by"),
            (("--group-by", "group"), "requires --sum"),
            (("--where", "missing=x"), "unknown column"),
            (("--where", "broken"), "malformed filter"),
            (("--group-by", "group", "--sum", "amount"), "row 2, column 'amount'"),
        )
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                result = self.run_cli("group,amount\r\na,nope\r\n", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
