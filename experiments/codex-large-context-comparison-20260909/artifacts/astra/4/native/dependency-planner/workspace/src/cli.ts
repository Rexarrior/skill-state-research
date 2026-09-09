import { plan } from "./planner";

async function main() {
  const args = Bun.argv.slice(2);
  if (args[0] !== "plan") throw new Error("Expected command: plan. Usage: bun run src/cli.ts plan INPUT.json");
  if (args.some(arg => arg.startsWith("-"))) throw new Error("Unknown flag. Usage: bun run src/cli.ts plan INPUT.json");
  if (args.length !== 2) throw new Error("Expected exactly one input file. Usage: bun run src/cli.ts plan INPUT.json");
  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    throw new Error(`Cannot read input ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : error}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
  console.log(JSON.stringify(plan(input)));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
