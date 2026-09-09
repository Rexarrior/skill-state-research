import csv
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

import main


class CsvInsightsTests(unittest.TestCase):
    def invoke(self, contents, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "input.csv")
            path.write_text(contents, encoding="utf-8", newline="")
            output = io.StringIO(newline="")
            errors = io.StringIO()
            parser = main.build_parser()
            args = parser.parse_args([str(path), *arguments])
            with redirect_stderr(errors):
                try:
                    main.run(args, parser, output)
                except main.CsvInsightsError as error:
                    print(f"error: {error}", file=errors)
                    return 1, output.getvalue(), errors.getvalue()
            return 0, output.getvalue(), errors.getvalue()

    def test_filters_and_preserves_embedded_content(self):
        source = 'name,note,status\r\nAda,"first, second",yes\r\nBob,"two\nlines",no\r\n'
        code, output, _ = self.invoke(source, "--where", "status=no")
        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(output),
            [{"name": "Bob", "note": "two\nlines", "status": "no"}],
        )

    def test_sum_average_sorting_and_decimal_format(self):
        source = "group,amount,score\r\nz,0.10,1\r\na,1.20,2\r\na,2.30,3\r\n"
        code, output, _ = self.invoke(
            source,
            "--group-by",
            "group",
            "--sum",
            "amount",
            "--avg",
            "score",
            "--output",
            "csv",
        )
        self.assertEqual(code, 0)
        self.assertEqual(
            list(csv.reader(io.StringIO(output))),
            [["group", "sum_amount", "avg_score"], ["a", "3.5", "2.5"], ["z", "0.1", "1"]],
        )

    def test_sum_does_not_round_at_decimal_context_precision(self):
        source = "group,value\na,10000000000000000000000000000\na,1\n"
        code, output, _ = self.invoke(source, "--group-by", "group", "--sum", "value")
        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(output),
            [{"group": "a", "sum_value": "10000000000000000000000000001"}],
        )

    def test_multiple_filters_are_combined(self):
        source = "a,b\n1,x\n1,y\n2,x\n"
        code, output, _ = self.invoke(source, "--where", "a=1", "--where", "b=x")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output), [{"a": "1", "b": "x"}])

    def test_rejects_invalid_shape_and_headers(self):
        for source, fragment in (
            ("a,a\n1,2\n", "unique"),
            ("a,\n1,2\n", "non-empty"),
            ("a,b\n1\n", "row 2"),
        ):
            with self.subTest(source=source):
                code, _, errors = self.invoke(source)
                self.assertEqual(code, 1)
                self.assertIn(fragment, errors)

    def test_invalid_number_reports_record_and_column(self):
        source = "team,value\na,nope\n"
        code, _, errors = self.invoke(
            source, "--group-by", "team", "--sum", "value"
        )
        self.assertEqual(code, 1)
        self.assertIn("row 2, column 'value'", errors)

    def test_unknown_column_and_malformed_filter(self):
        source = "a\n1\n"
        code, _, errors = self.invoke(source, "--where", "missing=x")
        self.assertEqual(code, 1)
        self.assertIn("unknown column", errors)
        code, _, errors = self.invoke(source, "--where", "a")
        self.assertEqual(code, 1)
        self.assertIn("malformed", errors)


if __name__ == "__main__":
    unittest.main()
