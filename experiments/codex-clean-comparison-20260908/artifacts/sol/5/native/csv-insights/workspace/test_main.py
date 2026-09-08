import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(contents, encoding="utf-8", newline="")
            original = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_bytes(), original)
            return result

    def test_filter_preserves_quoted_fields_and_embedded_newlines(self):
        result = self.invoke(
            'name,note,kind\r\n"Ada, A.","first\nsecond",x\r\nBob,no,y\r\n',
            "--where", "kind=x",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "Ada, A.", "note": "first\nsecond", "kind": "x"}],
        )

    def test_grouped_decimal_sum_and_average_are_sorted(self):
        result = self.invoke(
            "group,amount\r\nz,0.1\r\na,1.20\r\nz,0.2\r\na,3.80\r\n",
            "--group-by", "group", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "5", "avg_amount": "2.5"},
                {"group": "z", "sum_amount": "0.3", "avg_amount": "0.15"},
            ],
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.invoke('a,b\r\n"x,y","line 1\nline 2"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout, newline=""))),
            [["a", "b"], ["x,y", "line 1\nline 2"]],
        )

    def test_invalid_numeric_cell_identifies_record_and_column(self):
        result = self.invoke(
            "team,score\r\nred,4\r\nblue,nope\r\n",
            "--group-by", "team", "--sum", "score",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3", result.stderr)
        self.assertIn("score", result.stderr)

    def test_rejects_duplicate_headers_and_wrong_width(self):
        duplicate = self.invoke("a,a\r\n1,2\r\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        uneven = self.invoke("a,b\r\n1\r\n")
        self.assertNotEqual(uneven.returncode, 0)
        self.assertIn("row 2", uneven.stderr)

    def test_unknown_column_and_malformed_filter_fail(self):
        unknown = self.invoke("a\r\n1\r\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        malformed = self.invoke("a\r\n1\r\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_exact_sum_exceeds_default_decimal_precision(self):
        result = self.invoke(
            "g,n\r\nx,9999999999999999999999999999\r\nx,1\r\n",
            "--group-by", "g", "--sum", "n",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]["sum_n"], "10000000000000000000000000000")

    def test_empty_result_and_invalid_aggregate_arguments(self):
        empty = self.invoke("a,b\r\n1,2\r\n", "--where", "a=missing")
        self.assertEqual(empty.returncode, 0, empty.stderr)
        self.assertEqual(json.loads(empty.stdout), [])
        missing_group = self.invoke("a,b\r\n1,2\r\n", "--sum", "b")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)

    def test_blank_and_non_finite_numeric_values_are_rejected(self):
        for value in ("", "NaN", "Infinity"):
            with self.subTest(value=value):
                result = self.invoke(
                    f"g,n\r\nx,{value}\r\n",
                    "--group-by", "g", "--avg", "n",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2", result.stderr)


if __name__ == "__main__":
    unittest.main()
