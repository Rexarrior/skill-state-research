type InputTask = {
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

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown): InputTask[] {
  if (!isRecord(value)) fail("Invalid input: expected a JSON object");
  if (!Array.isArray(value.tasks)) fail('Invalid input: "tasks" must be an array');

  const tasks: InputTask[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`Invalid input: ${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`Invalid input: duplicate task id "${raw.id}"`);
    ids.add(raw.id);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn)) fail(`Invalid input: ${label}.dependsOn must be an array`);
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOn.length; dependencyIndex++) {
      const dependency = dependsOn[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid input: ${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid input: ${label}.dependsOn contains duplicate id "${dependency}"`);
      }
      seenDependencies.add(dependency);
    }
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependsOn] as string[] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`Invalid input: task "${task.id}" cannot depend on itself`);
      if (!ids.has(dependency)) {
        fail(`Invalid input: task "${task.id}" references unknown dependency "${dependency}"`);
      }
    }
  }
  return tasks;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: InputTask[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stackPositions.get(dependency)), dependency];
      }
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...dependencies.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function plan(tasks: InputTask[]): Schedule {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)?.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
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
    fail(`Dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = {};
  const paths = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    let bestPrefix: string[] | undefined;
    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency].finish;
      const dependencyPath = paths.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPrefix === undefined || compareSequences(dependencyPath, bestPrefix) < 0))
      ) {
        start = dependencyFinish;
        bestPrefix = dependencyPath;
      }
    }
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    paths.set(id, [...(bestPrefix ?? []), id]);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = paths.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration && (criticalPath.length === 0 || compareSequences(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Could not read "${args[1]}": ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON: ${detail}`);
  }
  console.log(JSON.stringify(plan(validate(input))));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
