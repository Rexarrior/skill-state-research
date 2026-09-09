export interface TaskInput {
  id: string;
  duration: number;
  dependsOn?: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function comparePaths(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index++) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateInput(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`input must be an object, received ${describe(input)}`);
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new Error(`tasks must be an array, received ${describe(tasksValue)}`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const value = tasksValue[index];
    const location = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${location} must be an object`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      throw new Error(`duplicate task id: ${JSON.stringify(record.id)}`);
    }
    ids.add(record.id);

    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    const dependencies = record.dependsOn === undefined ? [] : record.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new Error(`${location}.dependsOn must be an array of unique strings`);
    }

    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(
          `${location}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
    }

    tasks.push({ id: record.id, duration: record.duration, dependsOn: [...dependencies] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `task ${JSON.stringify(task.id)} references unknown dependency ` +
            JSON.stringify(dependency),
        );
      }
    }
    task.dependsOn.sort(compareIds);
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    for (const dependency of tasksById.get(id)!.dependsOn) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(stackPositions.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }

  throw new Error("cycle detected");
}

export function createPlan(input: unknown): Plan {
  const tasks = validateInput(input);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const ids of dependents.values()) ids.sort(compareIds);

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
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new Error(`dependency cycle: ${findCycle(tasksById).join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPredecessorPath: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      const dependencyPath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPredecessorPath.length === 0 ||
            comparePaths(dependencyPath, bestPredecessorPath) < 0))
      ) {
        start = dependencyFinish;
        bestPredecessorPath = dependencyPath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...bestPredecessorPath, id]);
    (layers[layer] ??= []).push(id);
  }

  for (const ids of layers) ids.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = pathById.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[0] !== "plan") {
    throw new Error(`unknown command ${JSON.stringify(args[0])}; expected "plan"`);
  }
  if (args.length !== 2) {
    throw new Error("usage: bun run src/cli.ts plan INPUT.json (no flags are supported)");
  }
  if (args[1].startsWith("-")) {
    throw new Error(`unknown flag ${JSON.stringify(args[1])}; no flags are supported`);
  }

  const inputPath = args[1];
  let source: string;
  try {
    source = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${JSON.stringify(inputPath)}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(inputPath)}: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
