import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent


class CliTests(unittest.TestCase):
    def invoke(self, content, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.csv"
            source.write_text(content, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "main.py"), str(source), *arguments],
                text=True,
                capture_output=True,
                check=False,
            )

    def test_filter_preserves_quoted_content_and_input_order(self):
        result = self.invoke(
            'name,note,kind\r\nfirst,"hello, world",x\r\nsecond,"two\nlines",y\r\n',
            "--where", "kind=y",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"name": "second", "note": "two\nlines", "kind": "y"}],
        )

    def test_decimal_aggregates_sort_groups_and_emit_json_numbers(self):
        result = self.invoke(
            "group,amount,units\r\nb,0.1,2\r\na,1.20,2\r\nb,0.2,4\r\n",
            "--group-by", "group", "--sum", "amount", "--avg", "units",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout,
            '[{"group": "a", "sum_amount": 1.2, "avg_units": 2}, '
            '{"group": "b", "sum_amount": 0.3, "avg_units": 3}]\n',
        )

    def test_csv_output_is_rfc_quoted(self):
        result = self.invoke('a,b\r\n"x,y","line 1\nline 2"\r\n', "--output", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            list(csv.reader(result.stdout.splitlines(keepends=True))),
            [["a", "b"], ["x,y", "line 1\nline 2"]],
        )

    def test_rejects_bad_width_and_invalid_number(self):
        width = self.invoke("a,b\n1\n")
        self.assertNotEqual(width.returncode, 0)
        self.assertIn("row 2", width.stderr)

        number = self.invoke("g,n\na,nope\n", "--group-by", "g", "--sum", "n")
        self.assertNotEqual(number.returncode, 0)
        self.assertIn("row 2, column 'n'", number.stderr)

    def test_rejects_headers_filters_columns_and_missing_group(self):
        duplicate = self.invoke("a,a\n1,2\n")
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("unique", duplicate.stderr)

        malformed = self.invoke("a\n1\n", "--where", "a")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("COLUMN=VALUE", malformed.stderr)

        unknown = self.invoke("a\n1\n", "--where", "missing=x")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown column", unknown.stderr)

        group = self.invoke("a\n1\n", "--sum", "a")
        self.assertNotEqual(group.returncode, 0)
        self.assertIn("require --group-by", group.stderr)

        duplicate_output = self.invoke(
            "g,n\na,1\n", "--group-by", "g", "--sum", "n", "--sum", "n"
        )
        self.assertNotEqual(duplicate_output.returncode, 0)
        self.assertIn("output column names are not unique", duplicate_output.stderr)


if __name__ == "__main__":
    unittest.main()
