import { render } from "./engine.ts";

function usage(): never {
  throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) usage();

  const [templatePath, dataPath] = args;
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${dataPath}: ${message}`);
  }
  process.stdout.write(render(template, data));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mini-template: ${message}\n`);
  process.exitCode = 1;
});
