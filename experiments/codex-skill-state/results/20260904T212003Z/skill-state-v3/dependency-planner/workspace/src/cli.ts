#!/usr/bin/env bun

import { planInput } from "./planner";

function usageError(message: string): never {
  throw new Error(`${message}. Usage: bun run src/cli.ts plan INPUT.json`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usageError("missing command");
  if (args[0] !== "plan") usageError(`unknown command: ${args[0]}`);
  if (args.length < 2) usageError("missing input file");
  if (args.length > 2) usageError(`unknown argument or flag: ${args[2]}`);

  const inputPath = args[1]!;
  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${inputPath}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${inputPath}: ${detail}`);
  }

  console.log(JSON.stringify(planInput(input)));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
