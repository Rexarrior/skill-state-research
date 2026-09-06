import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsTests(unittest.TestCase):
    def run_tool(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.csv"
            input_path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(input_path), *arguments],
                capture_output=True,
                text=True,
            )

    def test_filter_preserves_order_and_handles_rfc_quoted_fields(self):
        result = self.run_tool(
            'kind,note\nkeep,"first, note"\nskip,ignored\nkeep,"two\nlines"\n',
            "--where",
            "kind=keep",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"kind": "keep", "note": "first, note"}, {"kind": "keep", "note": "two\nlines"}],
        )

    def test_sum_and_average_are_decimal_and_groups_are_sorted(self):
        result = self.run_tool(
            "team,amount\nb,0.1\na,2\nb,0.2\na,3\n",
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
                {"team": "a", "sum_amount": "5", "avg_amount": "2.5"},
                {"team": "b", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.run_tool('name,note\na,"has, comma"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["name", "note"], ["a", "has, comma"]])

    def test_invalid_numeric_value_identifies_row_and_column(self):
        result = self.run_tool("team,amount\na,1\na,nope\n", "--group-by", "team", "--sum", "amount")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3", result.stderr)
        self.assertIn("'amount'", result.stderr)

    def test_rejects_bad_header_width_and_filter(self):
        result = self.run_tool("a,a\n1,2\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unique", result.stderr)

        result = self.run_tool("a,b\n1,2,3\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected 2", result.stderr)

        result = self.run_tool("a,b\n1,2\n", "--where", "missing=1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown column", result.stderr)


if __name__ == "__main__":
    unittest.main()
