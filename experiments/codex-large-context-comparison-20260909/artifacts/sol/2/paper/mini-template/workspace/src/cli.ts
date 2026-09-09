import { render } from "./engine";

const [templatePath, dataPath, ...extra] = Bun.argv.slice(2);

if (templatePath === undefined || dataPath === undefined || extra.length > 0) {
  console.error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  process.exit(1);
}

try {
  const [template, dataSource] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  const data: unknown = JSON.parse(dataSource);
  process.stdout.write(render(template, data));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mini-template: ${message}`);
  process.exit(1);
}
