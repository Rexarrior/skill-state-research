type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Invalid input: expected a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.tasks)) {
    fail('Invalid input: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`Invalid input: ${label} must be an object`);
    }

    const task = raw as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      fail(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) {
      fail(`Invalid input: duplicate task id "${task.id}"`);
    }
    if (
      typeof task.duration !== "number" ||
      !Number.isFinite(task.duration) ||
      task.duration < 0
    ) {
      fail(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`Invalid input: ${label}.dependsOn must be an array of strings`);
    }

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(
          `Invalid input: ${label}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid input: ${label}.dependsOn contains duplicate "${dependency}"`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(task.id);
    tasks.push({ id: task.id, duration: task.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        fail(`Invalid input: task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        fail(`Invalid input: task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
  }

  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle].localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        const start = stackIndex.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  }

  const ids = [...tasksById.keys()].sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
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
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    fail(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const earliest: Record<string, Timing> = {};
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
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

  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

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
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[1].startsWith("-")) {
    fail(`Unknown flag: ${args[1]}`);
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read input file "${args[1]}": ${detail}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON in "${args[1]}": ${detail}`);
  }

  const plan = createPlan(parseTasks(value));
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
