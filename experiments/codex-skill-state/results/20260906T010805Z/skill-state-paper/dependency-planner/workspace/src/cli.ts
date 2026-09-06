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
  console.error(`Error: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareSequences(left: string[], right: string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = left[index]!.localeCompare(right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function parseTasks(input: unknown): Task[] {
  if (!isRecord(input)) fail("input must be a JSON object");
  if (!Array.isArray(input.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const rawTask = input.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(rawTask)) fail(`${location} must be an object`);

    if (typeof rawTask.id !== "string" || rawTask.id.length === 0) {
      fail(`${location}.id must be a non-empty string`);
    }
    if (ids.has(rawTask.id)) fail(`duplicate task id: ${rawTask.id}`);
    ids.add(rawTask.id);

    if (
      typeof rawTask.duration !== "number" ||
      !Number.isFinite(rawTask.duration) ||
      rawTask.duration < 0
    ) {
      fail(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = rawTask.dependsOn ?? [];
    if (!Array.isArray(rawDependencies)) {
      fail(`${location}.dependsOn must be an array`);
    }
    const dependsOn: string[] = [];
    const dependenciesSeen = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependenciesSeen.has(dependency)) {
        fail(`${location}.dependsOn contains duplicate id: ${dependency}`);
      }
      dependenciesSeen.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: rawTask.id, duration: rawTask.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) {
        fail(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(stackPositions.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...byId.keys()].sort((a, b) => a.localeCompare(b))) {
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
    if (values[middle]!.localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function buildPlan(tasks: Task[]): Plan {
  const cycle = findCycle(tasks);
  if (cycle !== null) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
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

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPredecessorPath: string[] | null = null;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyPath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPredecessorPath === null ||
            compareSequences(dependencyPath, bestPredecessorPath) < 0))
      ) {
        start = dependencyFinish;
        bestPredecessorPath = dependencyPath;
      }
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...(bestPredecessorPath ?? []), id]);
    (layers[layer] ??= []).push(id);
  }

  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id]!.finish;
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
  if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`unknown command: ${args[0]}`);
  if (args.length < 2) fail("missing input file");
  if (args.length > 2) fail(`unknown flag or argument: ${args[2]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read input file: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON: ${detail}`);
  }

  console.log(JSON.stringify(buildPlan(parseTasks(input))));
}

await main();
