import { render } from "./engine";

const [templateFile, dataFile] = Bun.argv.slice(2);

if (!templateFile || !dataFile || Bun.argv.slice(2).length !== 2) {
  console.error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  process.exit(1);
}

try {
  const [template, dataText] = await Promise.all([
    Bun.file(templateFile).text(),
    Bun.file(dataFile).text(),
  ]);
  process.stdout.write(render(template, JSON.parse(dataText)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
