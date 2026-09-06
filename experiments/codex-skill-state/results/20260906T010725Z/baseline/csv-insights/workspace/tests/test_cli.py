import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
PROGRAM = PROJECT / "main.py"


class CliTests(unittest.TestCase):
    def run_cli(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filters_exactly_and_preserves_quoted_fields(self):
        result = self.run_cli(
            'name,note,kind\r\n"A, B","first\nsecond",x\r\nC,plain,y\r\n',
            "--where",
            "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "A, B", "note": "first\nsecond", "kind": "x"}],
        )

    def test_multiple_filters_use_and(self):
        result = self.run_cli(
            "a,b\n1,2\n1,3\n",
            "--where",
            "a=1",
            "--where",
            "b=3",
        )
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "3"}])

        combined = self.run_cli("a,b\n1,2\n1,3\n", "--where", "a=1", "b=2")
        self.assertEqual(json.loads(combined.stdout), [{"a": "1", "b": "2"}])

    def test_sum_and_average_are_grouped_sorted_and_exact(self):
        result = self.run_cli(
            "team,amount,score\nz,0.1,1\na,0.2,2\nz,0.2,2\n",
            "--group-by",
            "team",
            "--sum",
            "amount",
            "--avg",
            "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"team": "a", "sum_amount": "0.2", "avg_score": "2"},
                {"team": "z", "sum_amount": "0.3", "avg_score": "1.5"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.run_cli('name,note\n"A, B","x""y"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout))),
            [["name", "note"], ["A, B", 'x"y']],
        )

    def test_wrong_field_count_is_an_error(self):
        result = self.run_cli("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("expected 2", result.stderr)

    def test_unterminated_quoted_field_is_an_error(self):
        result = self.run_cli('a,b\n1,"unfinished\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed CSV", result.stderr)

    def test_duplicate_and_empty_headers_are_errors(self):
        duplicate = self.run_cli("a,a\n1,2\n")
        empty = self.run_cli("a,\n1,2\n")
        empty_row = self.run_cli("\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("non-empty", empty.stderr)
        self.assertNotEqual(empty_row.returncode, 0)
        self.assertIn("header", empty_row.stderr)

    def test_invalid_number_identifies_row_and_column(self):
        result = self.run_cli(
            "group,value\na,nope\n",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("value", result.stderr)

    def test_unknown_column_and_malformed_filter_are_errors(self):
        unknown = self.run_cli("a\n1\n", "--where", "b=1")
        malformed = self.run_cli("a\n1\n", "--where", "a")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_aggregation_requires_valid_option_combination(self):
        no_group = self.run_cli("a\n1\n", "--sum", "a")
        no_operation = self.run_cli("a\n1\n", "--group-by", "a")
        self.assertNotEqual(no_group.returncode, 0)
        self.assertNotEqual(no_operation.returncode, 0)

    def test_invalid_number_in_filtered_out_row_is_ignored(self):
        result = self.run_cli(
            "group,value,keep\na,bad,no\na,2,yes\n",
            "--where",
            "keep=yes",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"group": "a", "sum_value": "2"}])

    def test_large_decimal_sum_does_not_round(self):
        result = self.run_cli(
            "group,value\na,9999999999999999999999999999\na,1\n",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "a", "sum_value": "10000000000000000000000000000"}],
        )


if __name__ == "__main__":
    unittest.main()
