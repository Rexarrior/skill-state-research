import { plan } from "./planner";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    throw new Error("Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)");
  }
  let content: string;
  try {
    content = await Bun.file(args[1]).text();
  } catch (error) {
    throw new Error(`Cannot read ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : error}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
  console.log(JSON.stringify(plan(input)));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
