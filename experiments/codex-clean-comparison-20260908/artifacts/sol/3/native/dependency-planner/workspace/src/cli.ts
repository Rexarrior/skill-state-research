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

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function comparePaths(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareIds(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateInput(input: unknown): Task[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`input must be an object (received ${describe(input)})`);
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new Error(`tasks must be an array (received ${describe(tasksValue)})`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const location = `tasks[${index}]`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${location} must be an object`);
    }

    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) {
      throw new Error(`duplicate task id: ${JSON.stringify(candidate.id)}`);
    }
    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    let dependsOn: string[];
    if (candidate.dependsOn === undefined) {
      dependsOn = [];
    } else if (Array.isArray(candidate.dependsOn)) {
      dependsOn = [];
      const dependencies = new Set<string>();
      for (let dependencyIndex = 0; dependencyIndex < candidate.dependsOn.length; dependencyIndex += 1) {
        const dependency = candidate.dependsOn[dependencyIndex];
        if (typeof dependency !== "string") {
          throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
        }
        if (dependencies.has(dependency)) {
          throw new Error(
            `${location}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`,
          );
        }
        dependencies.add(dependency);
        dependsOn.push(dependency);
      }
    } else {
      throw new Error(`${location}.dependsOn must be an array`);
    }

    ids.add(candidate.id);
    tasks.push({ id: candidate.id, duration: candidate.duration, dependsOn });
  }

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`,
        );
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
    if (compareIds(values[middle]!, value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(tasks: Task[]): Schedule {
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

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;
  const layers: string[][] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    const eligiblePaths = task.dependsOn
      .filter((dependency) => earliest[dependency]!.finish === start)
      .map((dependency) => [...pathById.get(dependency)!, id]);
    eligiblePaths.push([id]);
    const targetDuration = finish;
    const matchingPaths = eligiblePaths.filter((path) =>
      path.reduce((sum, pathId) => sum + tasksById.get(pathId)!.duration, 0) === targetDuration,
    );
    matchingPaths.sort(comparePaths);
    pathById.set(id, matchingPaths[0]!);
  }

  for (const layer of layers) layer.sort(compareIds);

  let criticalPath: string[] = [];
  if (tasks.length > 0) {
    const candidates = order
      .filter((id) => earliest[id]!.finish === totalDuration)
      .map((id) => pathById.get(id)!)
      .sort(comparePaths);
    criticalPath = candidates[0]!;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
    throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  }

  let contents: string;
  try {
    contents = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(validateInput(input))));
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  }
}
