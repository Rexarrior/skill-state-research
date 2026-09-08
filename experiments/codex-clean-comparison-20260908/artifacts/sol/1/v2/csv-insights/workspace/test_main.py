import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path), *arguments],
                text=True, capture_output=True, check=False,
            )

    def test_filters_exactly_and_preserves_complex_csv(self):
        result = self.invoke(
            'name,note,kind\r\nAlice,"one, two",x\r\nBob,"line 1\nline 2",x\r\nEve,,y\r\n',
            "--where", "kind=x", "--where", "name=Bob", "--output", "csv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout, newline=""))),
            [["name", "note", "kind"], ["Bob", "line 1\nline 2", "x"]],
        )

    def test_grouped_sum_and_average_are_sorted_decimal_strings(self):
        result = self.invoke(
            "team,amount,score\nB,0.10,2\nA,1.20,2\nA,2.30,3\nB,0.20,3\n",
            "--group-by", "team", "--sum", "amount", "--avg", "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"team": "A", "sum_amount": "3.5", "avg_score": "2.5"},
            {"team": "B", "sum_amount": "0.3", "avg_score": "2.5"},
        ])

    def test_sum_preserves_more_than_default_decimal_precision(self):
        result = self.invoke(
            "group,amount\nall,123456789012345678901234567890.1\nall,0.9\n",
            "--group-by", "group", "--sum", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "all", "sum_amount": "123456789012345678901234567891"}],
        )

    def test_empty_filtered_result_still_has_csv_header(self):
        result = self.invoke("a,b\n1,2\n", "--where", "a=no", "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "a,b\n" if sys.platform == "win32" else "a,b\n")

    def test_wrong_field_count_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("expected 2", result.stderr)

    def test_bad_numeric_value_identifies_row_and_column(self):
        result = self.invoke("g,n\na,nope\n", "--group-by", "g", "--sum", "n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)
        self.assertIn("column 'n'", result.stderr)

    def test_rejects_duplicate_empty_and_unknown_headers(self):
        for content, expected in (
            ("a,a\n1,2\n", "duplicate header"),
            ("a,\n1,2\n", "non-empty"),
        ):
            with self.subTest(content=content):
                result = self.invoke(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
        result = self.invoke("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown column", result.stderr)

    def test_rejects_malformed_filter_and_invalid_aggregation_arguments(self):
        malformed = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)
        missing_group = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)

    def test_input_file_is_not_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            original = b"a,b\r\n1,2\r\n"
            path.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(path)],
                capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
