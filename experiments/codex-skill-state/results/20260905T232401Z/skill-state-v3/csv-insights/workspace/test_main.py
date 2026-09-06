import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class CsvInsightsTests(unittest.TestCase):
    def run_cli(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            result = subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(source.read_text(encoding="utf-8", newline=""), content)
            return result

    def test_filter_json_preserves_order_and_embedded_content(self):
        result = self.run_cli(
            'name,team,note\r\n"Doe, Jane",red,"first\nsecond"\r\nBob,blue,x\r\nAna,red,y\r\n',
            "--where", "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"name": "Doe, Jane", "team": "red", "note": "first\nsecond"},
            {"name": "Ana", "team": "red", "note": "y"},
        ])

    def test_filters_are_anded_and_value_can_contain_equals(self):
        result = self.run_cli("a,b\n1,x=y\n1,z\n2,x=y\n", "--where", "a=1", "--where", "b=x=y")
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x=y"}])

    def test_sum_and_average_are_decimal_and_groups_sorted(self):
        result = self.run_cli(
            "group,amount,score\nb,0.1,1\na,1.20,2\nb,0.2,2\na,2.30,3\n",
            "--group-by", "group", "--sum", "amount", "--avg", "score",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '[{"group": "a", "sum_amount": 3.5, "avg_score": 2.5}, {"group": "b", "sum_amount": 0.3, "avg_score": 1.5}]\n')

    def test_csv_output_quotes_fields(self):
        result = self.run_cli('a,b\n"x,y","line1\nline2"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(result.stdout.splitlines(keepends=True))), [["a", "b"], ["x,y", "line1\nline2"]])

    def test_wrong_width_is_error(self):
        result = self.run_cli("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2 has 1 fields; expected 2", result.stderr)

    def test_bad_headers_are_errors(self):
        for content, message in [("a,a\n1,2\n", "unique"), ("a,\n1,2\n", "non-empty")]:
            with self.subTest(content=content):
                result = self.run_cli(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_unknown_column_and_bad_filter_are_errors(self):
        unknown = self.run_cli("a\n1\n", "--where", "missing=x")
        malformed = self.run_cli("a\n1\n", "--where", "a")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_blank_invalid_and_nonfinite_numbers_identify_row_and_column(self):
        for value in ("", "wat", "NaN", "Infinity"):
            with self.subTest(value=value):
                result = self.run_cli(f"g,n\na,{value}\n", "--group-by", "g", "--sum", "n")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("row 2, column 'n'", result.stderr)

    def test_aggregation_requires_group_by(self):
        result = self.run_cli("a\n1\n", "--sum", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --group-by", result.stderr)

    def test_empty_result(self):
        result = self.run_cli("a,b\n1,x\n", "--where", "a=missing")
        self.assertEqual(result.stdout, "[]\n")


if __name__ == "__main__":
    unittest.main()
