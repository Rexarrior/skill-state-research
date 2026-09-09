declare const Bun: {
  readonly argv: string[];
  file(path: string): { text(): Promise<string> };
};

declare const process: {
  readonly stdout: { write(value: string): unknown };
  exitCode: number | undefined;
};
