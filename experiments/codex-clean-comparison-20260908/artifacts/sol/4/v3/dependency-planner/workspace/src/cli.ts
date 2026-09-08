type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

class InputError extends Error {}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(a[index], b[index]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError("tasks must be an array");
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const raw = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new InputError(`${label} must be an object`);
    }

    const object = raw as Record<string, unknown>;
    if (typeof object.id !== "string" || object.id.length === 0) {
      throw new InputError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(object.id)) {
      throw new InputError(`duplicate task id: ${object.id}`);
    }
    if (typeof object.duration !== "number" || !Number.isFinite(object.duration) || object.duration < 0) {
      throw new InputError(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = object.dependsOn === undefined ? [] : object.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new InputError(`${label}.dependsOn must be an array`);
    }
    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        throw new InputError(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === object.id) {
        throw new InputError(`task ${object.id} cannot depend on itself`);
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(object.id);
    tasks.push({ id: object.id, duration: object.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        const start = stackPositions.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareIds(values[middle], value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasksById);
  if (cycle) throw new InputError(`dependency cycle: ${cycle.join(" -> ")}`);

  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort(compareIds);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
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

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPredecessorPath: string[] | null = null;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      if (dependencyFinish > start) {
        start = dependencyFinish;
        bestPredecessorPath = pathById.get(dependency)!;
      } else if (dependencyFinish === start) {
        const candidate = pathById.get(dependency)!;
        if (bestPredecessorPath === null || comparePaths(candidate, bestPredecessorPath) < 0) {
          bestPredecessorPath = candidate;
        }
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...(bestPredecessorPath ?? []), id]);
    totalDuration = Math.max(totalDuration, finish);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort(compareIds);

  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new InputError("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") throw new InputError(`unknown command: ${args[0]}`);
  if (args.length < 2) throw new InputError("missing input file\nusage: bun run src/cli.ts plan INPUT.json");
  if (args[1].startsWith("-")) throw new InputError(`unknown argument or flag: ${args[1]}`);
  if (args.length > 2) throw new InputError(`unknown argument or flag: ${args[2]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`could not read ${args[1]}: ${message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in ${args[1]}: ${message}`);
  }

  console.log(JSON.stringify(createPlan(parseTasks(value))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
