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

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(`Invalid schema: expected a JSON object, got ${describe(input)}`);
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    fail(`Invalid schema: "tasks" must be an array, got ${describe(tasksValue)}`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const value = tasksValue[index];
    const location = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`Invalid schema: ${location} must be an object`);
    }

    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid schema: ${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      fail(`Invalid schema: duplicate task id "${raw.id}"`);
    }
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`Invalid schema: ${location}.duration must be a finite non-negative number`);
    }

    const dependsOnValue = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOnValue)) {
      fail(`Invalid schema: ${location}.dependsOn must be an array of strings`);
    }
    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOnValue.length; dependencyIndex++) {
      const dependency = dependsOnValue[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid schema: ${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        fail(`Invalid schema: ${location}.dependsOn contains duplicate id "${dependency}"`);
      }
      if (dependency === raw.id) {
        fail(`Invalid schema: task "${raw.id}" cannot depend on itself`);
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`Invalid schema: task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...byId.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function createPlan(tasks: Task[]): Plan {
  const cycle = findCycle(tasks);
  if (cycle !== null) fail(`Dependency cycle detected: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
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
      if (remaining === 0) {
        const insertionPoint = ready.findIndex((candidate) => candidate.localeCompare(dependent) > 0);
        if (insertionPoint === -1) ready.push(dependent);
        else ready.splice(insertionPoint, 0, dependent);
      }
    }
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, Timing> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    let bestPrefix: string[] = [];

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency].finish;
      const dependencyPath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPrefix.length === 0 || compareSequences(dependencyPath, bestPrefix) < 0))
      ) {
        start = dependencyFinish;
        bestPrefix = dependencyPath;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    pathById.set(id, [...bestPrefix, id]);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = pathById.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || compareSequences(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0) fail("Usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`Unknown command "${args[0]}". Expected "plan".`);
  if (args.length < 2) fail("Missing input file. Usage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) fail(`Unknown argument or flag "${args[2]}"`);

  const inputPath = args[1];
  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read input file "${inputPath}": ${detail}`);
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
