import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsCliTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filter_preserves_quoted_content_and_order(self):
        result = self.invoke(
            'name,team,note\nAlice,A,"hello, world"\nBob,B,"two\nlines"\nCara,A,last\n',
            "--where", "team=A",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Alice", "team": "A", "note": "hello, world"},
                {"name": "Cara", "team": "A", "note": "last"},
            ],
        )

    def test_grouped_decimal_sum_and_average_are_sorted_and_minimal(self):
        result = self.invoke(
            "group,amount\nz,0.10\na,1.20\na,1.30\nz,0.20\n",
            "--group-by", "group", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "2.5", "avg_amount": "1.25"},
                {"group": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_quotes_values(self):
        result = self.invoke('name,note\nAlice,"hello, world"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["name", "note"], ["Alice", "hello, world"]])
        self.assertIn('"hello, world"', result.stdout)

    def test_invalid_numeric_value_reports_record_and_column(self):
        result = self.invoke(
            "group,amount\na,nope\n", "--group-by", "group", "--sum", "amount"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_uneven_row_is_rejected(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2 has 1 fields; expected 2", result.stderr)

    def test_duplicate_and_empty_headers_are_rejected(self):
        duplicate = self.invoke("a,a\n1,2\n")
        empty = self.invoke("a,\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("non-empty", empty.stderr)

    def test_unknown_column_and_malformed_filter_are_rejected(self):
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        malformed = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_aggregation_requires_group_by(self):
        result = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()
