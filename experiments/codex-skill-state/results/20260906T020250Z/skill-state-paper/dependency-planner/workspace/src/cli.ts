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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) fail("Invalid input: top-level value must be an object");
  if (!Array.isArray(input.tasks)) fail('Invalid input: "tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`Invalid input: ${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`Invalid input: duplicate task id "${raw.id}"`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }
    if (raw.dependsOn !== undefined && !Array.isArray(raw.dependsOn)) {
      fail(`Invalid input: ${label}.dependsOn must be an array`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOn.length; dependencyIndex++) {
      const dependency = dependsOn[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid input: ${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid input: ${label}.dependsOn contains duplicate "${dependency}"`);
      }
      seenDependencies.add(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependsOn] });
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

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle].localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const position = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    position.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(position.get(dependency)!), dependency];
      }
    }

    stack.pop();
    position.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...dependencies.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function lexicographicallyLess(left: string[], right: string[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison < 0;
  }
  return left.length < right.length;
}

function plan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();

  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
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
      if (count === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`Dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPath: string[] = [];

    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidatePath = pathById.get(dependency)!;
      if (finish > start || (finish === start && (bestPath.length === 0 || lexicographicallyLess(candidatePath, bestPath)))) {
        start = finish;
        bestPath = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    pathById.set(id, [...bestPath, id]);
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidatePath = pathById.get(id)!;
    if (finish > totalDuration || (finish === totalDuration && (criticalPath.length === 0 || lexicographicallyLess(candidatePath, criticalPath)))) {
      totalDuration = finish;
      criticalPath = candidatePath;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) fail("Usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`Unknown command: ${args[0]}`);
  if (args.length < 2) fail("Missing input file\nUsage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) fail(`Unknown argument or flag: ${args[2]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`Cannot read input file "${args[1]}": ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(plan(validate(input))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  console.error(error instanceof CliError ? error.message : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
