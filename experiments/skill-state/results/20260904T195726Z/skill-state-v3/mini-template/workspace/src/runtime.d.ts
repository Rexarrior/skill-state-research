declare const Bun: {
  argv: string[];
  stdout: unknown;
  file(path: string): { text(): Promise<string> };
  write(destination: unknown, content: string): Promise<number>;
};

declare const process: {
  exit(code: number): never;
};
