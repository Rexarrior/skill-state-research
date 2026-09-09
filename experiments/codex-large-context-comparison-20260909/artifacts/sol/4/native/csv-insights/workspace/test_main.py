import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(contents, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_exactly_and_preserves_complex_csv_values(self) -> None:
        result = self.invoke(
            'name,team,note\r\n"Doe, Jo",red,"first\nsecond"\r\nSam,blue,ok\r\n',
            "--where",
            "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Doe, Jo", "team": "red", "note": "first\nsecond"}],
        )

    def test_grouped_decimal_sum_and_average_are_sorted_and_exact(self) -> None:
        result = self.invoke(
            "team,amount\r\nz,0.1\r\na,1.00\r\nz,0.2\r\na,4\r\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--avg",
            "amount",
        )

        long_sum = self.invoke(
            "team,amount\na,123456789012345678901234567890\na,0.1\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
        )
        self.assertEqual(long_sum.returncode, 0, long_sum.stderr)
        self.assertEqual(
            json.loads(long_sum.stdout)[0]["sum_amount"],
            "123456789012345678901234567890.1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "5", "avg_amount": "2.5"},
                {"team": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self) -> None:
        result = self.invoke('name,note\r\nA,"x,y"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [["name", "note"], ["A", "x,y"]])

    def test_bad_row_and_bad_numeric_cell_report_context(self) -> None:
        bad_row = self.invoke("a,b\n1\n")
        self.assertNotEqual(bad_row.returncode, 0)
        self.assertIn("row 2", bad_row.stderr)

        bad_number = self.invoke(
            "team,amount\na,nope\n", "--group-by", "team", "--sum", "amount"
        )
        self.assertNotEqual(bad_number.returncode, 0)
        self.assertIn("row 2", bad_number.stderr)
        self.assertIn("amount", bad_number.stderr)

    def test_invalid_headers_filters_and_columns_fail(self) -> None:
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

        malformed = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("COLUMN=VALUE", malformed.stderr)

        unknown = self.invoke("a\n1\n", "--where", "missing=1")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

    def test_aggregates_require_group_and_empty_csv_output_keeps_header(self) -> None:
        missing_group = self.invoke("amount\n1\n", "--sum", "amount")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)

        empty = self.invoke(
            "team,amount\na,1\n",
            "--where",
            "team=missing",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--output",
            "csv",
        )
        self.assertEqual(empty.returncode, 0, empty.stderr)
        self.assertEqual(empty.stdout, "team,sum_amount\n")


if __name__ == "__main__":
    unittest.main()
