import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parent
PROGRAM = PROJECT / "main.py"


class CsvInsightsCliTests(unittest.TestCase):
    def invoke(
        self, content: str, *arguments: str
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            result = subprocess.run(
                [sys.executable, str(PROGRAM), str(source), *arguments],
                capture_output=True,
                check=False,
            )
            return subprocess.CompletedProcess(
                result.args,
                result.returncode,
                result.stdout.decode("utf-8"),
                result.stderr.decode("utf-8"),
            )

    def test_filter_preserves_order_and_handles_quoted_content(self) -> None:
        result = self.invoke(
            'name,note,status\r\nAlice,"hello, world",active\r\n'
            'Bob,"two\nlines",inactive\r\nCara,plain,active\r\n',
            "--where",
            "status=active",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Alice", "note": "hello, world", "status": "active"},
                {"name": "Cara", "note": "plain", "status": "active"},
            ],
        )

    def test_multiple_filters_use_and(self) -> None:
        result = self.invoke(
            "kind,region,value\na,x,1\na,y,2\nb,x,3\n",
            "--where",
            "kind=a",
            "--where",
            "region=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"kind": "a", "region": "x", "value": "1"}],
        )

    def test_sum_and_average_are_decimal_strings_and_groups_are_sorted(self) -> None:
        result = self.invoke(
            "team,amount,score\nz,0.10,1\na,2.40,2\nz,0.20,2\na,0.60,3\n",
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
                {"team": "a", "sum_amount": "3", "avg_score": "2.5"},
                {"team": "z", "sum_amount": "0.3", "avg_score": "1.5"},
            ],
        )

    def test_csv_output_is_parseable_and_has_header(self) -> None:
        result = self.invoke(
            'name,note\nAlice,"hello, world"\n', "--output", "csv"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout, newline=""))),
            [["name", "note"], ["Alice", "hello, world"]],
        )
        self.assertIn("\r\n", result.stdout)

    def test_duplicate_and_empty_headers_are_errors(self) -> None:
        duplicate = self.invoke("a,a\n1,2\n")
        empty = self.invoke("a,\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("non-empty", empty.stderr)

    def test_wrong_field_count_is_an_error(self) -> None:
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("expected 2", result.stderr)

    def test_bad_numeric_cell_names_row_and_column(self) -> None:
        result = self.invoke(
            "group,value\nx,nope\n", "--group-by", "group", "--sum", "value"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("value", result.stderr)

    def test_non_finite_and_blank_numbers_are_errors(self) -> None:
        non_finite = self.invoke(
            "group,value\nx,NaN\n", "--group-by", "group", "--sum", "value"
        )
        blank = self.invoke(
            "group,value\nx,\n", "--group-by", "group", "--avg", "value"
        )
        self.assertNotEqual(non_finite.returncode, 0)
        self.assertIn("invalid numeric", non_finite.stderr)
        self.assertNotEqual(blank.returncode, 0)
        self.assertIn("blank numeric", blank.stderr)

    def test_decimal_sum_is_not_rounded_by_default_context(self) -> None:
        result = self.invoke(
            "group,value\nx,123456789012345678901234567890.01\nx,0.09\n",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {
                    "group": "x",
                    "sum_value": "123456789012345678901234567890.1",
                }
            ],
        )

    def test_unknown_column_malformed_filter_and_missing_group_are_errors(self) -> None:
        unknown = self.invoke("a,b\n1,2\n", "--where", "missing=x")
        malformed = self.invoke("a,b\n1,2\n", "--where", "a")
        missing_group = self.invoke("a,b\n1,2\n", "--sum", "b")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)

    def test_unterminated_quoted_field_is_an_error(self) -> None:
        result = self.invoke('a,b\n1,"unfinished\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed CSV", result.stderr)

    def test_quote_inside_unquoted_field_is_an_error(self) -> None:
        result = self.invoke('a,b\n1,not"quoted\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed CSV", result.stderr)


if __name__ == "__main__":
    unittest.main()
