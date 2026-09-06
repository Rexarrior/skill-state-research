from __future__ import annotations

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
    def run_cli(self, content: str, *arguments: str) -> subprocess.CompletedProcess[str]:
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
            self.assertEqual(source.read_bytes(), before)
            return result

    def test_filter_preserves_order_and_rfc_fields(self) -> None:
        result = self.run_cli(
            'name,team,note\r\n"Ada, A",red,"first\nline"\r\nBob,blue,x\r\nCara,red,y\r\n',
            "--where",
            "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Ada, A", "team": "red", "note": "first\nline"},
                {"name": "Cara", "team": "red", "note": "y"},
            ],
        )

    def test_group_sum_and_average_are_sorted_and_decimal(self) -> None:
        result = self.run_cli(
            "group,amount,score\r\nb,0.1,2\r\na,1.20,1\r\nb,0.2,3\r\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "score",
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [
                ["group", "sum_amount", "avg_score"],
                ["a", "1.2", "1"],
                ["b", "0.3", "2.5"],
            ],
        )

    def test_multiple_filters_use_and_and_allow_equals_in_value(self) -> None:
        result = self.run_cli(
            "a,b\n1,x=y\n1,z\n2,x=y\n",
            "--where",
            "a=1",
            "--where",
            "b=x=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x=y"}])

    def test_bad_row_width_is_an_error(self) -> None:
        result = self.run_cli("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_invalid_number_identifies_row_and_column(self) -> None:
        result = self.run_cli(
            "g,n\na,nope\n",
            "--group-by",
            "g",
            "--sum",
            "n",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("column 'n'", result.stderr)

    def test_duplicate_and_unknown_columns_are_errors(self) -> None:
        duplicate = self.run_cli("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

        unknown = self.run_cli("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

    def test_aggregation_requires_group_by(self) -> None:
        result = self.run_cli("a\n1\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--group-by", result.stderr)


if __name__ == "__main__":
    unittest.main()
