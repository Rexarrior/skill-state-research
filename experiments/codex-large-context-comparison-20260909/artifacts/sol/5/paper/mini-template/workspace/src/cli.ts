import { render } from "./engine";

function usage(): never {
  throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) usage();

  const [templateFile, dataFile] = args;
  const [template, json] = await Promise.all([
    Bun.file(templateFile).text(),
    Bun.file(dataFile).text(),
  ]);

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${dataFile}: ${detail}`);
  }

  process.stdout.write(render(template, data));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
