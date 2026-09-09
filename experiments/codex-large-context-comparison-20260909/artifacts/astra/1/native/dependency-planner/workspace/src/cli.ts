import { plan } from "./planner";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
    throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
  }
  let contents: string;
  try {
    contents = await Bun.file(args[1]!).text();
  } catch (error) {
    throw new Error(`Cannot read input file ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(input)));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
