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

function parseTasks(value: unknown): Task[] {
  if (!isRecord(value)) {
    fail("input must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) {
    fail("'tasks' must be an array");
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const at = `tasks[${index}]`;
    if (!isRecord(raw)) {
      fail(`${at} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${at}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      fail(`duplicate task id '${raw.id}'`);
    }
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      fail(`${at}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`${at}.dependsOn must be an array`);
    }
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${at}.dependsOn contains duplicate id '${dependency}'`);
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
        fail(`task '${task.id}' cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        fail(`task '${task.id}' depends on unknown id '${dependency}'`);
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

function compareSequences(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndexes = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndexes.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndexes.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackIndexes.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...tasksById.keys()].sort()) {
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
      const count = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    fail(`cycle detected: ${cycle.join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, Timing> = {};
  const pathDuration = new Map<string, number>();
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;
    let bestDependencyPath: string[] = [];
    let bestDependencyDuration = 0;
    let hasDependencyPath = false;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      start = Math.max(start, earliest[dependency].finish);

      const dependencyDuration = pathDuration.get(dependency)!;
      const dependencyPath = pathById.get(dependency)!;
      if (
        !hasDependencyPath ||
        dependencyDuration > bestDependencyDuration ||
        (dependencyDuration === bestDependencyDuration &&
          compareSequences(dependencyPath, bestDependencyPath) < 0)
      ) {
        hasDependencyPath = true;
        bestDependencyDuration = dependencyDuration;
        bestDependencyPath = dependencyPath;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    pathDuration.set(id, bestDependencyDuration + task.duration);
    pathById.set(id, [...bestDependencyPath, id]);
  }

  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  let hasCriticalPath = false;
  for (const id of order) {
    const duration = pathDuration.get(id)!;
    const path = pathById.get(id)!;
    if (
      !hasCriticalPath ||
      duration > totalDuration ||
      (duration === totalDuration && compareSequences(path, criticalPath) < 0)
    ) {
      hasCriticalPath = true;
      totalDuration = duration;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[0] !== "plan") {
    fail(`unknown command '${args[0]}'`);
  }
  if (args.length < 2) {
    fail("missing input file; usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args.length > 2) {
    fail(`unknown argument or flag '${args[2]}'`);
  }

  const inputPath = args[1];
  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read '${inputPath}': ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in '${inputPath}': ${detail}`);
  }

  console.log(JSON.stringify(createPlan(parseTasks(input))));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
