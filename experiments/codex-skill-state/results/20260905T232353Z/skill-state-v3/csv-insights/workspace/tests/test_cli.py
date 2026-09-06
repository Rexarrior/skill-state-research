from __future__ import annotations

import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / "main.py"


class CsvInsightsCliTests(unittest.TestCase):
    def run_cli(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            input_path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(input_path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_rfc_csv_and_multiple_filters_preserve_rows(self) -> None:
        result = self.run_cli(
            'name,region,note\r\n"Ada, A.",East,"line one\nline two"\r\nBob,West,x\r\nCara,East,y\r\n',
            "--where",
            "region=East",
            "--where",
            "name=Ada, A.",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A.", "region": "East", "note": "line one\nline two"}],
        )

    def test_decimal_aggregates_are_exact_minimal_and_sorted(self) -> None:
        result = self.run_cli(
            "group,amount,count\nB,0.10,1\nA,1.20,2\nB,0.20,2\nA,1.30,3\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "amount",
            "--sum",
            "count",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "A", "sum_amount": "2.5", "sum_count": "5", "avg_amount": "1.25"},
                {"group": "B", "sum_amount": "0.3", "sum_count": "3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self) -> None:
        result = self.run_cli('name,note\n"Doe, Jane","hello, world"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout))),
            [["name", "note"], ["Doe, Jane", "hello, world"]],
        )
        self.assertIn('"Doe, Jane"', result.stdout)

    def test_invalid_header_and_wrong_width_are_errors(self) -> None:
        duplicate = self.run_cli("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        self.assertEqual(duplicate.stdout, "")

        uneven = self.run_cli("a,b\n1,2\n3\n")
        self.assertNotEqual(uneven.returncode, 0)
        self.assertIn("row 3", uneven.stderr)
        self.assertIn("expected 2 fields, found 1", uneven.stderr)
        self.assertEqual(uneven.stdout, "")

    def test_invalid_numeric_cell_identifies_row_and_column(self) -> None:
        result = self.run_cli(
            "group,amount\nA,1\nB,not-a-number\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3", result.stderr)
        self.assertIn("column 'amount'", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_unknown_column_and_malformed_filter_are_errors(self) -> None:
        unknown = self.run_cli("a,b\n1,2\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

        malformed = self.run_cli("a,b\n1,2\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("expected COLUMN=VALUE", malformed.stderr)

    def test_aggregation_requires_group_by(self) -> None:
        result = self.run_cli("a,b\n1,2\n", "--sum", "b")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)

    def test_input_file_is_not_modified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            original = b"a,b\r\n1,2\r\n"
            input_path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(input_path)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(input_path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
