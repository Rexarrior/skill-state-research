import { plan } from "./planner";

try {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-"))
    throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
  let input: unknown;
  const text = await Bun.file(args[1]).text();
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(input)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
