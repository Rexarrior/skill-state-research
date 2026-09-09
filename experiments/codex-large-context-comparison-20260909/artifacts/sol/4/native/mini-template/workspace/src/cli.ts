import { render } from "./engine.ts";

async function main(): Promise<void> {
  const [templatePath, dataPath, ...extra] = Bun.argv.slice(2);
  if (!templatePath || !dataPath || extra.length > 0) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  const data: unknown = JSON.parse(json);
  process.stdout.write(render(template, data));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mini-template: ${message}`);
  process.exitCode = 1;
}
