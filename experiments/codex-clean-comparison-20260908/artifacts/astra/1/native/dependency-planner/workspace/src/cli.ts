import { createPlan } from "./planner";

const usage = "Usage: bun run src/cli.ts plan INPUT.json";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.some((arg) => arg.startsWith("-"))) {
    throw new Error(`Unknown flag: ${args.find((arg) => arg.startsWith("-"))}.\n${usage}`);
  }
  if (args[0] !== "plan") {
    throw new Error(`Unknown or missing command${args[0] ? `: ${args[0]}` : ""}.\n${usage}`);
  }
  if (args.length !== 2) throw new Error(`Expected exactly one input file.\n${usage}`);
  let contents: string;
  try {
    contents = await Bun.file(args[1]!).text();
  } catch (error) {
    throw new Error(`Cannot read input file ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(input)));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
