import { render } from "./engine";

declare const Bun: {
  argv: string[];
  stdout: unknown;
  file(path: string): { text(): Promise<string> };
  write(destination: unknown, content: string): Promise<number>;
  exit(code: number): never;
};

async function main(): Promise<void> {
  try {
    const [templatePath, dataPath, ...extra] = Bun.argv.slice(2);
    if (!templatePath || !dataPath || extra.length > 0) {
      throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
    }

    const [template, json] = await Promise.all([
      Bun.file(templatePath).text(),
      Bun.file(dataPath).text(),
    ]);
    const data: unknown = JSON.parse(json);
    await Bun.write(Bun.stdout, render(template, data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    Bun.exit(1);
  }
}

await main();
