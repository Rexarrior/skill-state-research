import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parent


class CsvInsightsCliTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROJECT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_preserve_order_and_parse_quoted_records(self):
        result = self.invoke(
            'name,note,kind\r\nAlice,"hello, world",x\r\nBob,"two\nlines",y\r\n',
            "--where",
            "kind=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Bob", "note": "two\nlines", "kind": "y"}],
        )

    def test_sum_and_average_are_sorted_and_exact_strings(self):
        result = self.invoke(
            "team,amount\r\nb,0.1\r\na,1.20\r\nb,0.2\r\na,2.30\r\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--avg",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "3.5", "avg_amount": "1.75"},
                {"team": "b", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_has_header_and_valid_quoting(self):
        result = self.invoke('name,note\r\nA,"x,y"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [["name", "note"], ["A", "x,y"]])

    def test_invalid_number_identifies_record_and_column(self):
        result = self.invoke(
            "team,amount\na,not-a-number\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_rejects_duplicate_headers_and_short_rows(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

        short = self.invoke("a,b\n1\n")
        self.assertNotEqual(short.returncode, 0)
        self.assertIn("row 2", short.stderr)

    def test_rejects_unknown_columns_and_aggregation_without_group(self):
        unknown = self.invoke("a\n1\n", "--where", "missing=1")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

        no_group = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(no_group.returncode, 0)
        self.assertIn("require --group-by", no_group.stderr)

    def test_empty_aggregate_and_group_by_without_aggregate(self):
        empty = self.invoke(
            "team,amount\na,1\n",
            "--where",
            "team=missing",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertEqual(empty.returncode, 0, empty.stderr)
        self.assertEqual(json.loads(empty.stdout), [])

        group_only = self.invoke("team,amount\nb,1\na,2\n", "--group-by", "team")
        self.assertEqual(group_only.returncode, 0, group_only.stderr)
        self.assertEqual(
            json.loads(group_only.stdout),
            [{"team": "b", "amount": "1"}, {"team": "a", "amount": "2"}],
        )

    def test_rejects_empty_headers_malformed_csv_and_non_finite_numbers(self):
        empty_header = self.invoke("a,\n1,2\n")
        self.assertNotEqual(empty_header.returncode, 0)
        self.assertIn("non-empty", empty_header.stderr)

        malformed = self.invoke('a,b\n1,"unterminated\n')
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed CSV", malformed.stderr)

        non_finite = self.invoke(
            "team,amount\na,NaN\n",
            "--group-by",
            "team",
            "--avg",
            "amount",
        )
        self.assertNotEqual(non_finite.returncode, 0)
        self.assertIn("row 2", non_finite.stderr)

    def test_large_decimal_sum_does_not_round(self):
        result = self.invoke(
            "team,amount\na,9999999999999999999999999999\na,1\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]["sum_amount"], "10000000000000000000000000000")


if __name__ == "__main__":
    unittest.main()
