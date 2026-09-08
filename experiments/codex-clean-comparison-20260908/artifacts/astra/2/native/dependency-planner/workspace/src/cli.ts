import { plan } from "./planner";

export async function main(args: string[]): Promise<void> {
  if (args[0] !== "plan") throw new Error("Unknown or missing command. Usage: bun run src/cli.ts plan INPUT.json");
  const flag = args.slice(1).find((arg) => arg.startsWith("-"));
  if (flag !== undefined) throw new Error(`Unknown flag: ${flag}`);
  if (args.length !== 2) throw new Error("Expected exactly one input file. Usage: bun run src/cli.ts plan INPUT.json");
  let source: string;
  try {
    source = await Bun.file(args[1]!).text();
  } catch (error) {
    throw new Error(`Cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
