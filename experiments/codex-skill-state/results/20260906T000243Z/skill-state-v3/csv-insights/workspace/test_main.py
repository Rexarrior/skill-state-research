import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROGRAM = ROOT / "main.py"


class CSVInsightsCLITests(unittest.TestCase):
    def run_cli(self, content: str, *args: str, newline: str = "") -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline=newline)
            original = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *args],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), original, "input file was modified")
            return result

    def assert_error(self, result: subprocess.CompletedProcess[str], *fragments: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        for fragment in fragments:
            self.assertIn(fragment, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_json_preserves_rows_and_parses_quoted_fields(self) -> None:
        result = self.run_cli(
            'name,note,kind\r\nAlice,"hello, world",x\r\nBob,"line 1\r\nline 2",y\r\n'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Alice", "note": "hello, world", "kind": "x"},
                {"name": "Bob", "note": "line 1\r\nline 2", "kind": "y"},
            ],
        )

    def test_multiple_filters_are_exact_and_combined_with_and(self) -> None:
        result = self.run_cli(
            "name,team,status\nAnn,A,open\nAnne,A,open\nAnn,B,open\nAnn,A,closed\n",
            "--where",
            "name=Ann",
            "--where",
            "team=A",
            "--where",
            "status=open",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"name": "Ann", "team": "A", "status": "open"}])

    def test_grouped_sum_and_average_are_sorted_and_minimal(self) -> None:
        result = self.run_cli(
            "group,amount\nz,1.20\na,2\nz,1.30\na,3\n",
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
                {"group": "a", "sum_amount": "5", "avg_amount": "2.5"},
                {"group": "z", "sum_amount": "2.5", "avg_amount": "1.25"},
            ],
        )

    def test_sum_and_average_may_use_different_columns(self) -> None:
        result = self.run_cli(
            "g,x,y\na,0.01,1\na,0.02,2\n",
            "--group-by",
            "g",
            "--sum",
            "x",
            "--avg",
            "y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"g": "a", "sum_x": "0.03", "avg_y": "1.5"}],
        )

    def test_csv_output_is_rfc_quoted(self) -> None:
        result = self.run_cli('name,note\nAlice,"x,y"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["name", "note"], ["Alice", "x,y"]])

    def test_empty_filtered_aggregate_has_header_only_in_csv(self) -> None:
        result = self.run_cli(
            "g,x\na,1\n",
            "--where",
            "g=missing",
            "--group-by",
            "g",
            "--sum",
            "x",
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines())), [["g", "sum_x"]])

    def test_invalid_headers_and_row_width_are_errors(self) -> None:
        self.assert_error(self.run_cli("a,,b\n1,2,3\n"), "header", "empty")
        self.assert_error(self.run_cli("a,a\n1,2\n"), "header", "duplicate")
        self.assert_error(self.run_cli("a,b\n1\n"), "row 2", "1 fields", "expected 2")

    def test_unknown_columns_and_malformed_filters_are_errors(self) -> None:
        self.assert_error(self.run_cli("a,b\n1,2\n", "--where", "missing=x"), "unknown column", "missing")
        self.assert_error(self.run_cli("a,b\n1,2\n", "--where", "broken"), "malformed filter")
        self.assert_error(self.run_cli("a,b\n1,2\n", "--where", "=x"), "column name", "empty")

    def test_aggregation_requires_group_by(self) -> None:
        self.assert_error(self.run_cli("a,b\n1,2\n", "--sum", "b"), "--group-by")
        self.assert_error(self.run_cli("a,b\n1,2\n", "--group-by", "a"), "--sum", "--avg")

    def test_invalid_numeric_cells_identify_logical_row_and_column(self) -> None:
        self.assert_error(
            self.run_cli("g,x\na,1\na,\n", "--group-by", "g", "--sum", "x"),
            "row 3",
            "column 'x'",
        )
        self.assert_error(
            self.run_cli("g,x\na,nope\n", "--group-by", "g", "--avg", "x"),
            "row 2",
            "column 'x'",
        )

    def test_malformed_csv_is_an_error(self) -> None:
        self.assert_error(self.run_cli('a,b\n1,"unterminated\n'), "CSV")


if __name__ == "__main__":
    unittest.main()
