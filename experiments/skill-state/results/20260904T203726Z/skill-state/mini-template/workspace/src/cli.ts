import { render } from "./engine.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const [templateFile, dataFile] = Bun.argv.slice(2);
if (!templateFile || !dataFile || Bun.argv.length !== 4) {
  fail("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
}

try {
  const [template, json] = await Promise.all([
    Bun.file(templateFile).text(),
    Bun.file(dataFile).text(),
  ]);
  process.stdout.write(render(template, JSON.parse(json)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
