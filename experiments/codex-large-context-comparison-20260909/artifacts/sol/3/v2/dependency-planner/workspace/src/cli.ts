type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) fail("input must be a JSON object");
  if (!Array.isArray(input.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`${label}.dependsOn must be an array`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === raw.id) fail(`task ${raw.id} cannot depend on itself`);
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`task ${task.id} depends on unknown task: ${dependency}`);
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

function findCycle(tasks: Task[], remaining: Set<string>): string[] {
  const dependencies = new Map(
    tasks.map((task) => [
      task.id,
      task.dependsOn.filter((id) => remaining.has(id)).sort(),
    ]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        const start = stackIndex.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...remaining].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  throw new Error("cycle expected but not found");
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const indegree = new Map<string, number>();

  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const ids of dependents.values()) ids.sort();

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const next = indegree.get(dependent)! - 1;
      indegree.set(dependent, next);
      if (next === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const processed = new Set(order);
    const remaining = new Set(tasks.map((task) => task.id).filter((id) => !processed.has(id)));
    fail(`dependency cycle: ${findCycle(tasks, remaining).join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest = Object.create(null) as Record<string, Timing>;
  const bestWeight = new Map<string, number>();
  const bestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      start = Math.max(start, earliest[dependency].finish);
    }
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };

    let weight = task.duration;
    let path = [id];
    if (task.dependsOn.length > 0) {
      const firstDependency = task.dependsOn[0];
      weight = bestWeight.get(firstDependency)! + task.duration;
      path = [...bestPath.get(firstDependency)!, id];

      for (const dependency of task.dependsOn.slice(1)) {
        const candidateWeight = bestWeight.get(dependency)! + task.duration;
        const candidatePath = [...bestPath.get(dependency)!, id];
        if (
          candidateWeight > weight ||
          (candidateWeight === weight && comparePaths(candidatePath, path) < 0)
        ) {
          weight = candidateWeight;
          path = candidatePath;
        }
      }
    }
    bestWeight.set(id, weight);
    bestPath.set(id, path);
  }

  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const weight = bestWeight.get(id)!;
    const path = bestPath.get(id)!;
    if (
      weight > totalDuration ||
      (weight === totalDuration &&
        (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))
    ) {
      totalDuration = weight;
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
  if (args.length > 2) fail(`unknown argument or flag: ${args[2]}`);

  const path = args[1];
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read input file ${path}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in ${path}: ${detail}`);
  }

  console.log(JSON.stringify(plan(validate(input))));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
