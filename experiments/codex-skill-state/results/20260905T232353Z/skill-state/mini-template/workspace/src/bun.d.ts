declare const Bun: {
  argv: string[];
  file(path: string): {
    text(): Promise<string>;
  };
  write(destination: { write(data: string): unknown }, data: string): Promise<number>;
  stderr: {
    write(data: string): unknown;
  };
};

declare const process: {
  exitCode?: number;
};
