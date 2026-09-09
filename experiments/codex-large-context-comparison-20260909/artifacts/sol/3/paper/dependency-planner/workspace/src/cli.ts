import { createSchedule, validateInput } from "./planner";

function fail(message: string): never {
  console.error(`dependency-planner: ${message}`);
  process.exit(1);
}

const args = Bun.argv.slice(2);
if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
if (args[0] !== "plan") fail(`unknown command: ${args[0]}`);
if (args.length !== 2) {
  const extra = args.find((argument, index) => index > 0 && argument.startsWith("-"));
  fail(extra ? `unknown flag: ${extra}` : "usage: bun run src/cli.ts plan INPUT.json");
}

let input: unknown;
try {
  input = JSON.parse(await Bun.file(args[1]!).text());
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail(`could not read valid JSON from "${args[1]}": ${detail}`);
}

try {
  console.log(JSON.stringify(createSchedule(validateInput(input))));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

