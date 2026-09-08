declare const Bun: {
  argv: string[];
  file(path: string): {
    text(): Promise<string>;
  };
};

declare const process: {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  exitCode: number | undefined;
};
