import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import main


class CsvInsightsTests(unittest.TestCase):
    def args(self, *arguments):
        return main.build_parser().parse_args(["unused.csv", *arguments])

    def process(self, text, *arguments):
        return main.process(self.args(*arguments), io.StringIO(text, newline=""))

    def test_filter_preserves_rows_and_rfc_fields(self):
        header, rows = self.process(
            'name,note,kind\r\nAlice,"hello, world",x\r\nBob,"two\nlines",y\r\n',
            "--where", "kind=y",
        )
        self.assertEqual(header, ["name", "note", "kind"])
        self.assertEqual(rows, [{"name": "Bob", "note": "two\nlines", "kind": "y"}])

    def test_grouped_decimal_aggregation_and_sorting(self):
        header, rows = self.process(
            "group,amount\nz,0.10\na,1.20\na,1.30\n",
            "--group-by", "group", "--sum", "amount", "--avg", "amount",
        )
        self.assertEqual(header, ["group", "sum_amount", "avg_amount"])
        self.assertEqual(rows, [
            {"group": "a", "sum_amount": "2.5", "avg_amount": "1.25"},
            {"group": "z", "sum_amount": "0.1", "avg_amount": "0.1"},
        ])

    def test_csv_output_quotes_fields(self):
        output = io.StringIO(newline="")
        main.emit(["name", "note"], [{"name": "A", "note": "x,y"}], "csv", output)
        self.assertEqual(list(csv.reader(io.StringIO(output.getvalue()))), [["name", "note"], ["A", "x,y"]])

    def test_validation_errors(self):
        cases = [
            ("a,a\n1,2\n", (), "unique"),
            ("a,b\n1\n", (), "expected 2 fields"),
            ("a,b\n1,x\n", ("--group-by", "a", "--sum", "b"), "row 2, column 'b'"),
            ("a\n1\n", ("--where", "missing=x"), "unknown column"),
            ("a\n1\n", ("--where", "broken"), "malformed filter"),
        ]
        for text, arguments, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(main.CsvInsightsError, message):
                self.process(text, *arguments)

    def test_command_line_json_and_nonzero_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.csv"
            path.write_text("k,v\nb,2\na,1\na,3\n", encoding="utf-8", newline="")
            command = [sys.executable, str(Path(main.__file__)), str(path), "--group-by", "k", "--avg", "v"]
            result = subprocess.run(command, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), [
                {"k": "a", "avg_v": "2"}, {"k": "b", "avg_v": "2"}
            ])
            bad = subprocess.run(command + ["--where", "oops"], text=True, capture_output=True, check=False)
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn("malformed filter", bad.stderr)


if __name__ == "__main__":
    unittest.main()
