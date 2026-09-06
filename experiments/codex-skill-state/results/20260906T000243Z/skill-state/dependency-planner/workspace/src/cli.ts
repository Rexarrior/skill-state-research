type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) {
    fail("Invalid schema: root must be an object");
  }
  if (!Array.isArray(input.tasks)) {
    fail('Invalid schema: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(raw)) {
      fail(`Invalid schema: ${location} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid schema: ${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      fail(`Invalid schema: duplicate task id "${raw.id}"`);
    }
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      fail(`Invalid schema: ${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`Invalid schema: ${location}.dependsOn must be an array`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(
          `Invalid schema: ${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid schema: ${location}.dependsOn contains duplicate "${dependency}"`);
      }
      if (dependency === raw.id) {
        fail(`Invalid schema: task "${raw.id}" cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`Invalid schema: task "${task.id}" references unknown dependency "${dependency}"`);
      }
    }
  }

  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        const start = stackPositions.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort((a, b) => a.localeCompare(b))) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) {
    values.sort((a, b) => a.localeCompare(b));
  }

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    fail(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, Timing> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      start = Math.max(start, earliest[dependency].finish);
    }

    let path: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (earliest[dependency].finish !== start) continue;
      const candidate = [...pathById.get(dependency)!, id];
      if (path === undefined || compareSequences(candidate, path) < 0) {
        path = candidate;
      }
    }

    const finish = start + task.duration;
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish };
    pathById.set(id, path!);
  }

  for (const layer of layers) {
    layer.sort((a, b) => a.localeCompare(b));
  }

  let totalDuration = 0;
  let criticalPath: string[] | undefined;
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = pathById.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath === undefined || compareSequences(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath: criticalPath ?? [] };
}

function parseArguments(args: string[]): string {
  if (args.length === 0) {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[0].startsWith("-")) {
    fail(`Unknown flag: ${args[0]}`);
  }
  if (args[0] !== "plan") {
    fail(`Unknown command: ${args[0]}`);
  }
  for (const argument of args.slice(1)) {
    if (argument.startsWith("-")) fail(`Unknown flag: ${argument}`);
  }
  if (args.length < 2) fail("Missing input file");
  if (args.length > 2) fail(`Unexpected argument: ${args[2]}`);
  return args[1];
}

async function main(): Promise<void> {
  const inputPath = parseArguments(Bun.argv.slice(2));
  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read input file "${inputPath}": ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON in "${inputPath}": ${detail}`);
  }

  console.log(JSON.stringify(createPlan(validate(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
