type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Schedule = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

class CliError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDocument(value: unknown): Task[] {
  if (!isRecord(value)) {
    throw new CliError("Invalid schema: root must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) {
    throw new CliError('Invalid schema: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(raw)) {
      throw new CliError(`Invalid schema: ${location} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new CliError(`Invalid schema: ${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new CliError(`Invalid schema: duplicate task id "${raw.id}"`);
    }
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new CliError(`Invalid schema: ${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new CliError(`Invalid schema: ${location}.dependsOn must be an array`);
    }
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new CliError(
          `Invalid schema: ${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new CliError(
          `Invalid schema: ${location}.dependsOn contains duplicate id "${dependency}"`,
        );
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new CliError(`Invalid schema: task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new CliError(
          `Invalid schema: task "${task.id}" references unknown dependency "${dependency}"`,
        );
      }
    }
  }

  return tasks;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...tasksById.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  throw new Error("Cycle expected but not found");
}

function plan(tasks: Task[]): Schedule {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) values.sort();

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new CliError(`Dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, { start: number; finish: number }> = {};
  const criticalTo = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;
    let bestDependencyPath: string[] | undefined;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency].finish;
      const dependencyPath = criticalTo.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestDependencyPath === undefined || comparePaths(dependencyPath, bestDependencyPath) < 0))
      ) {
        start = dependencyFinish;
        bestDependencyPath = dependencyPath;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    criticalTo.set(id, [...(bestDependencyPath ?? []), id]);
  }

  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = criticalTo.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration && (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

const usage = "Usage: bun run src/cli.ts plan INPUT.json";

function parseArguments(args: string[]): string | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return null;
  if (args.length === 0) throw new CliError("Usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") {
    if (args[0].startsWith("-")) throw new CliError(`Unknown flag: ${args[0]}`);
    throw new CliError(`Unknown command: ${args[0]}`);
  }
  if (args.length < 2) throw new CliError("Missing input file\nUsage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) {
    const extra = args[2];
    if (extra.startsWith("-")) throw new CliError(`Unknown flag: ${extra}`);
    throw new CliError(`Unexpected argument: ${extra}`);
  }
  if (args[1].startsWith("-")) throw new CliError(`Unknown flag: ${args[1]}`);
  return args[1];
}

async function main(): Promise<void> {
  try {
    const inputPath = parseArguments(process.argv.slice(2));
    if (inputPath === null) {
      console.log(usage);
      return;
    }
    let text: string;
    try {
      text = await Bun.file(inputPath).text();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(`Cannot read input file "${inputPath}": ${detail}`);
    }

    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(`Invalid JSON in "${inputPath}": ${detail}`);
    }

    console.log(JSON.stringify(plan(validateDocument(document))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

await main();
