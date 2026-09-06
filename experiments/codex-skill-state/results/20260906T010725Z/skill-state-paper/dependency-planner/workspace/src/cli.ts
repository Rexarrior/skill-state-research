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

function compareSequences(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const rawTasks = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(rawTasks)) fail("tasks must be an array");

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < rawTasks.length; index += 1) {
    const rawTask = rawTasks[index];
    const location = `tasks[${index}]`;
    if (typeof rawTask !== "object" || rawTask === null || Array.isArray(rawTask)) {
      fail(`${location} must be an object`);
    }

    const record = rawTask as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      fail(`${location}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) fail(`duplicate task id: ${record.id}`);
    ids.add(record.id);

    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      fail(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = record.dependsOn === undefined ? [] : record.dependsOn;
    if (!Array.isArray(rawDependencies)) fail(`${location}.dependsOn must be an array`);

    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${location}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    tasks.push({ id: record.id, duration: record.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort((a, b) => a.localeCompare(b))]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(positions.get(dependency)), dependency];
      }
    }

    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...dependencies.keys()].sort((a, b) => a.localeCompare(b))) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
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

function createPlan(tasks: Task[]): Plan {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort((a, b) => a.localeCompare(b));

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
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, Timing> = {};
  const longestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = taskById.get(id)!;
    let layer = 0;
    let start = 0;
    let bestPrefix: string[] | null = null;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency].finish;
      const candidatePrefix = longestPath.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPrefix === null || compareSequences(candidatePrefix, bestPrefix) < 0))
      ) {
        start = dependencyFinish;
        bestPrefix = candidatePrefix;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    longestPath.set(id, [...(bestPrefix ?? []), id]);
  }

  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = longestPath.get(id)!;
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

function usage(): string {
  return "usage: bun run src/cli.ts plan INPUT.json";
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan") {
    if (args.some((argument) => argument.startsWith("-"))) {
      fail(`unknown flag; ${usage()}`);
    }
    if (args[0] !== undefined && args[0] !== "plan") fail(`unknown command: ${args[0]}; ${usage()}`);
    fail(usage());
  }

  const inputPath = args[1];
  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    fail(`cannot read ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON in ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(createPlan(parseTasks(input))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
