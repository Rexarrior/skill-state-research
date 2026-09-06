import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
PROGRAM = ROOT / "main.py"


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
            self.assertEqual(source.read_bytes(), before, "input file was modified")
            return result

    def test_filter_preserves_quoted_fields_and_embedded_newline(self):
        result = self.invoke(
            'name,note,kind\r\n"Ada, A.","line one\nline two",x\r\nBob,plain,y\r\n',
            "--where",
            "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A.", "note": "line one\nline two", "kind": "x"}],
        )

    def test_sum_and_average_are_decimal_sorted_and_minimal(self):
        result = self.invoke(
            "team,amount\nB,0.1\nA,1.00\nB,0.2\nA,2\n",
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
                {"team": "A", "sum_amount": "3", "avg_amount": "1.5"},
                {"team": "B", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )
        self.assertNotIn("0.300000", result.stdout)

    def test_csv_output_is_parseable_and_has_aggregate_headers(self):
        result = self.invoke(
            'group,value\n"x,y",2\n"x,y",3\n',
            "--group-by",
            "group",
            "--sum",
            "value",
            "--output",
            "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout))),
            [["group", "sum_value"], ["x,y", "5"]],
        )

    def test_multiple_filters_combine_with_and_and_allow_equals_in_value(self):
        result = self.invoke(
            "a,b\n1,x=y\n1,z\n2,x=y\n",
            "--where",
            "a=1",
            "--where",
            "b=x=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x=y"}])

    def test_bad_schema_and_unknown_column_are_errors(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("duplicate CSV header", duplicate.stderr)
        short = self.invoke("a,b\n1\n")
        self.assertNotEqual(short.returncode, 0)
        self.assertIn("row 2", short.stderr)
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

    def test_invalid_number_reports_logical_row_and_column(self):
        result = self.invoke(
            'group,note,value\nA,"two\nlines",bad\n',
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("column 'value'", result.stderr)

    def test_invalid_arguments_and_malformed_csv_are_errors(self):
        missing_group = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)
        malformed_filter = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed_filter.returncode, 0)
        self.assertIn("malformed filter", malformed_filter.stderr)
        malformed_csv = self.invoke('a,b\n"unterminated,1\n')
        self.assertNotEqual(malformed_csv.returncode, 0)
        self.assertIn("malformed CSV", malformed_csv.stderr)


if __name__ == "__main__":
    unittest.main()
