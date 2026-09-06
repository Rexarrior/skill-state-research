import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parent


class CliTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROJECT / "main.py"), str(path), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_exactly_and_preserves_multiline_fields(self):
        result = self.invoke(
            'name,region,note\r\n"A, Inc",West,"first\r\nsecond"\r\nB,East,x\r\n',
            "--where",
            "region=West",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "A, Inc", "region": "West", "note": "first\r\nsecond"}],
        )

    def test_grouped_sum_and_average_are_sorted_and_minimal(self):
        result = self.invoke(
            "group,amount\r\nz,0.10\r\na,1.20\r\na,1.30\r\nz,0.20\r\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "2.5", "avg_amount": "1.25"},
                {"group": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_quotes_special_values(self):
        result = self.invoke('name,note\r\nAlice,"hello, world"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines())),
            [["name", "note"], ["Alice", "hello, world"]],
        )

    def test_bad_numeric_cell_identifies_row_and_column(self):
        result = self.invoke(
            "group,amount\r\na,nope\r\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("amount", result.stderr)

    def test_rejects_wrong_field_count_and_duplicate_header(self):
        wrong_count = self.invoke("a,b\r\n1\r\n")
        self.assertNotEqual(wrong_count.returncode, 0)
        self.assertIn("row 2", wrong_count.stderr)

        duplicate = self.invoke("a,a\r\n1,2\r\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

    def test_sum_requires_group_by_and_unknown_columns_fail(self):
        missing_group = self.invoke("a,b\r\n1,2\r\n", "--sum", "b")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)

        unknown = self.invoke("a,b\r\n1,2\r\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)


if __name__ == "__main__":
    unittest.main()
