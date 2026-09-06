import { render } from "./engine";

const [templatePath, dataPath] = Bun.argv.slice(2);

if (!templatePath || !dataPath) {
  console.error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  process.exit(1);
}

try {
  const [template, dataText] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  process.stdout.write(render(template, JSON.parse(dataText)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
