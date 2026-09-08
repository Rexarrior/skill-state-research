import { render } from "./engine.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [templatePath, dataPath] = args as [string, string];
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  const data: unknown = JSON.parse(json);
  process.stdout.write(render(template, data));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mini-template: ${message}\n`);
  process.exitCode = 1;
});
