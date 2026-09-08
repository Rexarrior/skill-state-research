import { render } from "./engine";

try {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  const [template, json] = await Promise.all(args.map(path => Bun.file(path).text()));
  const text = render(template!, JSON.parse(json!));
  await Bun.write(Bun.stdout, text);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
