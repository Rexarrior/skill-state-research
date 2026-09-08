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
  const data: unknown = JSON.parse(json);
  process.stdout.write(render(template, data));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mini-template: ${message}\n`);
  process.exitCode = 1;
}
