from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            before = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), before, "the input file was modified")
            return result

    def test_filters_and_rfc_quoted_fields(self) -> None:
        result = self.invoke(
            'id,note,status\r\n1,"comma, here",ok\r\n2,"two\nlines",ok\r\n3,no,skip\r\n',
            "--where",
            "status=ok",
            "--where",
            "id=2",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"id": "2", "note": "two\nlines", "status": "ok"}])

    def test_grouped_sum_and_average_are_sorted_and_minimal(self) -> None:
        result = self.invoke(
            "group,amount,score\r\nb,1.20,2\r\na,0.01,2\r\nb,1.30,3\r\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "0.01", "avg_score": "2"},
                {"group": "b", "sum_amount": "2.5", "avg_score": "2.5"},
            ],
        )

    def test_csv_output_quotes_special_values(self) -> None:
        result = self.invoke('name,note\r\nA,"x,y"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'name,note\nA,"x,y"\n')

    def test_invalid_numeric_cell_identifies_record_and_column(self) -> None:
        result = self.invoke(
            "group,value\na,1\na,nope\n",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3, column 'value'", result.stderr)

    def test_filtered_out_invalid_numeric_cell_is_not_aggregated(self) -> None:
        result = self.invoke(
            "group,value,keep\na,2,yes\na,nope,no\n",
            "--where",
            "keep=yes",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"group": "a", "sum_value": "2"}])

    def test_rejects_bad_headers_and_row_widths(self) -> None:
        for content, message in (
            ("a,,b\n1,2,3\n", "non-empty"),
            ("a,a\n1,2\n", "unique"),
            ("a,b\n1\n", "row 2 has 1 fields; expected 2"),
        ):
            with self.subTest(content=content):
                result = self.invoke(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_rejects_unknown_columns_and_malformed_filters(self) -> None:
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column 'missing'", unknown.stderr)

        malformed = self.invoke("a\n1\n", "--where", "broken")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("expected COLUMN=VALUE", malformed.stderr)

    def test_aggregation_requires_group_by(self) -> None:
        result = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)

    def test_empty_aggregate_has_header_in_csv(self) -> None:
        result = self.invoke(
            "group,value\na,1\n",
            "--where",
            "group=missing",
            "--group-by",
            "group",
            "--avg",
            "value",
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "group,avg_value\n")


if __name__ == "__main__":
    unittest.main()
