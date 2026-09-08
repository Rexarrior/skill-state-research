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
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_quoted_fields_embedded_newline_and_exact_filters(self):
        result = self.invoke(
            'name,note,kind\r\n"A, B","first\nsecond",x\r\nC,z,y\r\n',
            "--where",
            "name=A, B",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "A, B", "note": "first\nsecond", "kind": "x"}],
        )

    def test_multiple_filters_are_and(self):
        result = self.invoke("a,b\n1,x\n1,y\n2,x\n", "--where", "a=1", "--where", "b=x")
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x"}])

    def test_grouped_sum_and_average_are_sorted_and_minimal(self):
        result = self.invoke(
            "team,amount\nz,1.20\na,0.01\nz,1.30\n",
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
                {"team": "a", "sum_amount": "0.01", "avg_amount": "0.01"},
                {"team": "z", "sum_amount": "2.5", "avg_amount": "1.25"},
            ],
        )

    def test_sum_is_exact_across_widely_separated_exponents(self):
        result = self.invoke(
            "g,n\nx,1e30\nx,1\n", "--group-by", "g", "--sum", "n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"g": "x", "sum_n": "1000000000000000000000000000001"}],
        )

    def test_csv_output_quotes_values(self):
        result = self.invoke('name,note\n"Doe, Jane","hello"\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [["name", "note"], ["Doe, Jane", "hello"]])

    def test_bad_width_is_an_error(self):
        result = self.invoke("a,b\n1\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 2", result.stderr)

    def test_duplicate_and_empty_headers_are_errors(self):
        duplicate = self.invoke("a,a\n1,2\n")
        empty = self.invoke("a,\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("non-empty", empty.stderr)

    def test_unknown_column_and_bad_filter_are_errors(self):
        unknown = self.invoke("a\n1\n", "--where", "b=1")
        malformed = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed filter", malformed.stderr)

    def test_malformed_csv_and_output_name_collision_are_errors(self):
        malformed = self.invoke('a,b\n"unterminated,1\n')
        collision = self.invoke(
            "sum_n,n\nx,1\n", "--group-by", "sum_n", "--sum", "n"
        )
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed CSV", malformed.stderr)
        self.assertNotEqual(collision.returncode, 0)
        self.assertIn("conflicts", collision.stderr)

    def test_aggregation_requires_group_and_rejects_bad_numbers(self):
        no_group = self.invoke("a\n1\n", "--sum", "a")
        bad_number = self.invoke("g,n\nx,nope\n", "--group-by", "g", "--avg", "n")
        blank = self.invoke("g,n\nx,\n", "--group-by", "g", "--sum", "n")
        self.assertNotEqual(no_group.returncode, 0)
        self.assertIn("require --group-by", no_group.stderr)
        self.assertNotEqual(bad_number.returncode, 0)
        self.assertIn("row 2, column 'n'", bad_number.stderr)
        self.assertNotEqual(blank.returncode, 0)
        self.assertIn("blank numeric", blank.stderr)

    def test_numeric_error_keeps_original_row_number_after_filtering(self):
        result = self.invoke(
            "kind,g,n\nskip,x,bad\nkeep,x,bad\n",
            "--where",
            "kind=keep",
            "--group-by",
            "g",
            "--sum",
            "n",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3, column 'n'", result.stderr)


if __name__ == "__main__":
    unittest.main()
