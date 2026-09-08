import { render } from "./engine";

async function main(): Promise<void> {
  const [templatePath, dataPath, ...extra] = Bun.argv.slice(2);
  if (!templatePath || !dataPath || extra.length) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid JSON in '${dataPath}': ${(error as Error).message}`);
  }
  process.stdout.write(render(template, data));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mini-template: ${message}\n`);
  process.exitCode = 1;
});
