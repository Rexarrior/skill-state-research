import { render } from "./engine";

async function main(): Promise<void> {
  const [templateFile, dataFile, ...extra] = Bun.argv.slice(2);
  if (!templateFile || !dataFile || extra.length > 0) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mini-template: ${message}\n`);
  process.exitCode = 1;
});
