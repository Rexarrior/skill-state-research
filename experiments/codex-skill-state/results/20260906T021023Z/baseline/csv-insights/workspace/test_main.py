import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent
PROGRAM = ROOT / "main.py"


class CsvInsightsCliTests(unittest.TestCase):
    def invoke(self, content: str, *arguments: str):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
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

    def test_filters_preserve_order_and_parse_quoted_fields(self):
        result = self.invoke(
            'name,team,note\r\n"Ada, A",red,"first\nsecond"\r\nBob,blue,ok\r\nCara,red,yes\r\n',
            "--where",
            "team=red",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"name": "Ada, A", "team": "red", "note": "first\nsecond"},
                {"name": "Cara", "team": "red", "note": "yes"},
            ],
        )

    def test_multiple_filters_are_exact_and_combine_with_and(self):
        result = self.invoke(
            "a,b\n1,x\n1,xy\n2,x\n",
            "--where",
            "a=1",
            "--where",
            "b=x",
        )
        self.assertEqual(json.loads(result.stdout), [{"a": "1", "b": "x"}])

    def test_sum_and_average_are_decimal_and_groups_are_sorted(self):
        result = self.invoke(
            "group,amount,count\nz,0.1,1\na,1.20,2\nz,0.2,2\na,1.30,3\n",
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "count",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"group": "a", "sum_amount": "2.5", "avg_count": "2.5"},
                {"group": "z", "sum_amount": "0.3", "avg_count": "1.5"},
            ],
        )

    def test_sum_does_not_round_large_decimals(self):
        result = self.invoke(
            "group,value\na,10000000000000000000000000000\na,1\n",
            "--group-by",
            "group",
            "--sum",
            "value",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"group": "a", "sum_value": "10000000000000000000000000001"}],
        )

    def test_csv_output_is_rfc_quoted_and_has_header_when_empty(self):
        result = self.invoke(
            'name,note\nAda,"x,y"\n', "--where", "name=Ada", "--output", "csv"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(io.StringIO(result.stdout))),
            [["name", "note"], ["Ada", "x,y"]],
        )
        empty = self.invoke("name,note\nAda,x\n", "--where", "name=Bob", "--output", "csv")
        self.assertEqual(empty.stdout, "name,note\n")

    def test_rejects_bad_headers_and_row_widths(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

        empty = self.invoke("a,\n1,2\n")
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("non-empty", empty.stderr)

        width = self.invoke("a,b\n1\n")
        self.assertNotEqual(width.returncode, 0)
        self.assertIn("row 2", width.stderr)
        self.assertIn("expected 2", width.stderr)

    def test_reports_numeric_row_and_column(self):
        result = self.invoke(
            "team,value\na,1\na,nope\n",
            "--group-by",
            "team",
            "--sum",
            "value",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("row 3", result.stderr)
        self.assertIn("column 'value'", result.stderr)

    def test_rejects_unknown_columns_malformed_filters_and_missing_group(self):
        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

        malformed = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("COLUMN=VALUE", malformed.stderr)

        missing_group = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(missing_group.returncode, 0)
        self.assertIn("require --group-by", missing_group.stderr)

        collision = self.invoke(
            "sum_value,value\na,1\n",
            "--group-by",
            "sum_value",
            "--sum",
            "value",
        )
        self.assertNotEqual(collision.returncode, 0)
        self.assertIn("duplicate output column", collision.stderr)

    def test_rejects_malformed_csv_and_blank_numbers(self):
        malformed = self.invoke('a,b\n"unterminated,x\n')
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("malformed CSV", malformed.stderr)

        blank = self.invoke(
            "team,value\na,\n", "--group-by", "team", "--avg", "value"
        )
        self.assertNotEqual(blank.returncode, 0)
        self.assertIn("numeric value is blank", blank.stderr)


if __name__ == "__main__":
    unittest.main()
