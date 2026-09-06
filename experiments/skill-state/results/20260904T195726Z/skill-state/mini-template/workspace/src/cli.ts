import { render } from "./engine";

async function main(): Promise<void> {
  const [templatePath, dataPath] = Bun.argv.slice(2);
  if (!templatePath || !dataPath || Bun.argv.length !== 4) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  process.stdout.write(render(template, JSON.parse(json)));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
