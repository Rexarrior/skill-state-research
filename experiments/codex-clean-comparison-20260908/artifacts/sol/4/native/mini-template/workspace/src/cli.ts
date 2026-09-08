import { render } from "./engine";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = Bun.argv.slice(2);
if (args.length !== 2) {
  fail("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
}

try {
  const [templatePath, dataPath] = args as [string, string];
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  const data: unknown = JSON.parse(json);
  process.stdout.write(render(template, data));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
