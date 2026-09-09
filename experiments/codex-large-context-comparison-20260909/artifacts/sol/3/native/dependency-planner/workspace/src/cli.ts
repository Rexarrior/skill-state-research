export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareStrings(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(value: unknown): Task[] {
  if (!isObject(value)) throw new Error("input must be a JSON object");
  if (!Array.isArray(value.tasks)) throw new Error('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isObject(raw)) throw new Error(`${location} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new Error(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new Error(`${location}.dependsOn must be an array of strings`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`${location}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === raw.id) throw new Error(`task ${raw.id} cannot depend on itself`);
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }
  return tasks;
}

/** Finds a deterministic cycle by visiting task ids and dependency ids in sorted order. */
function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareStrings);
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackPositions.get(dependency)), dependency];
      }
    }

    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort(compareStrings)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort(compareStrings);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareStrings);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(compareStrings);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new Error(`dependency cycle: ${cycle!.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPrefix: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      if (dependencyFinish > start) {
        start = dependencyFinish;
        bestPrefix = pathById.get(dependency)!;
      } else if (dependencyFinish === start) {
        const candidate = pathById.get(dependency)!;
        // Compare the complete paths: appending `id` can change the result when
        // one predecessor path is a prefix of another (possible with zero durations).
        if (
          bestPrefix.length === 0 ||
          comparePaths([...candidate, id], [...bestPrefix, id]) < 0
        ) bestPrefix = candidate;
      }
    }

    const finish = start + task.duration;
    const path = [...bestPrefix, id];
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, path);

    if (
      criticalPath.length === 0 ||
      finish > totalDuration ||
      (finish === totalDuration && comparePaths(path, criticalPath) < 0)
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const ids of layers) ids.sort(compareStrings);

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function planInput(value: unknown): Plan {
  return createPlan(validateInput(value));
}

function usageError(message: string): never {
  throw new Error(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

export async function main(args: string[]): Promise<void> {
  if (args.length === 0) usageError("missing command");
  if (args[0] !== "plan") {
    usageError(args[0].startsWith("-") ? `unknown flag: ${args[0]}` : `unknown command: ${args[0]}`);
  }
  if (args.length < 2) usageError("missing input file");
  if (args[1].startsWith("-")) usageError(`unknown flag: ${args[1]}`);
  if (args.length > 2) {
    usageError(args[2].startsWith("-") ? `unknown flag: ${args[2]}` : `unexpected argument: ${args[2]}`);
  }

  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    throw new Error(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(planInput(input)));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    Bun.exit(1);
  });
}
