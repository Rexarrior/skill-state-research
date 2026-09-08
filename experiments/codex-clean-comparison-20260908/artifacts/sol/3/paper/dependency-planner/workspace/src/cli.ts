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

function fail(message: string): never {
  throw new CliError(message);
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function parseTasks(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("Invalid input: expected a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    fail('Invalid input: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`Invalid input: ${label} must be an object`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      fail(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      fail(`Invalid input: duplicate task id "${record.id}"`);
    }
    if (typeof record.duration !== "number" || !Number.isFinite(record.duration) || record.duration < 0) {
      fail(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }

    const dependencies = record.dependsOn === undefined ? [] : record.dependsOn;
    if (!Array.isArray(dependencies)) {
      fail(`Invalid input: ${label}.dependsOn must be an array`);
    }

    const seenDependencies = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid input: ${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid input: ${label}.dependsOn contains duplicate id "${dependency}"`);
      }
      if (dependency === record.id) {
        fail(`Invalid input: task "${record.id}" cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(record.id);
    tasks.push({ id: record.id, duration: record.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`Invalid input: task "${task.id}" depends on unknown id "${dependency}"`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of tasks.map((task) => task.id).sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function createSchedule(tasks: Task[]): Schedule {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();

  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) values.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`Cycle detected: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const paths = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPrefix: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      const candidatePath = paths.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start && (bestPrefix.length === 0 || comparePaths(candidatePath, bestPrefix) < 0))
      ) {
        start = dependencyFinish;
        bestPrefix = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      fail(`Schedule duration exceeds the finite number range at task "${id}"`);
    }
    earliest[id] = { start, finish };
    paths.set(id, [...bestPrefix, id]);
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort();

  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id].finish), 0);
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = paths.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
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
    fail(`Could not read input file "${args[1]}": ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(createSchedule(parseTasks(input))));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
