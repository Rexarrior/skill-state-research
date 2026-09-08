import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROGRAM = ROOT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text(contents, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filter_preserves_quoted_fields_and_order(self):
        result = self.invoke(
            'name,note,kind\r\nfirst,"hello, world",x\r\nsecond,"two\nlines",x\r\nthird,no,y\r\n',
            "--where", "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "first", "note": "hello, world", "kind": "x"},
                {"name": "second", "note": "two\nlines", "kind": "x"},
            ],
        )

    def test_sum_and_average_are_decimal_and_groups_are_sorted(self):
        result = self.invoke(
            "team,amount,score\r\nz,0.1,1\r\na,1.20,2\r\nz,0.2,2\r\n",
            "--group-by", "team", "--sum", "amount", "--avg", "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "1.2", "avg_score": "2"},
                {"team": "z", "sum_amount": "0.3", "avg_score": "1.5"},
            ],
        )

    def test_sum_does_not_lose_widely_separated_decimal_places(self):
        result = self.invoke(
            "team,value\na,1e30\na,1\n",
            "--group-by", "team", "--sum", "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"team": "a", "sum_value": "1000000000000000000000000000001"}],
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.invoke('name,note\r\nA,"hello, world"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines(keepends=True))),
            [["name", "note"], ["A", "hello, world"]],
        )

    def test_multiple_filters_use_and(self):
        result = self.invoke(
            "a,b\n1,x\n1,y\n2,x\n", "--where", "a=1", "--where", "b=x"
        )
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x"}])

    def test_reports_bad_width_duplicate_header_and_unknown_column(self):
        cases = [
            ("a,b\n1\n", (), "row 2"),
            ("a,a\n1,2\n", (), "unique"),
            ("a,b\n1,2\n", ("--where", "missing=x"), "unknown column"),
        ]
        for contents, arguments, message in cases:
            with self.subTest(message=message):
                result = self.invoke(contents, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_reports_numeric_row_and_column(self):
        result = self.invoke(
            "team,value\na,nope\n", "--group-by", "team", "--sum", "value"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("value", result.stderr)

    def test_rejects_aggregation_without_group(self):
        result = self.invoke("a,b\n1,2\n", "--sum", "b")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()
