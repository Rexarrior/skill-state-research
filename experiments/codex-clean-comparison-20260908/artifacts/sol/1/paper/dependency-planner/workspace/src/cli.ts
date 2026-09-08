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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInput(value: unknown): Task[] {
  if (!isObject(value) || !Array.isArray(value.tasks)) {
    throw new Error('invalid input: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index += 1) {
    const rawTask = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isObject(rawTask)) {
      throw new Error(`invalid input: ${location} must be an object`);
    }
    if (typeof rawTask.id !== "string" || rawTask.id.length === 0) {
      throw new Error(`invalid input: ${location}.id must be a non-empty string`);
    }
    if (ids.has(rawTask.id)) {
      throw new Error(`invalid input: duplicate task id ${JSON.stringify(rawTask.id)}`);
    }
    if (
      typeof rawTask.duration !== "number" ||
      !Number.isFinite(rawTask.duration) ||
      rawTask.duration < 0
    ) {
      throw new Error(`invalid input: ${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = rawTask.dependsOn ?? [];
    if (!Array.isArray(rawDependencies)) {
      throw new Error(`invalid input: ${location}.dependsOn must be an array`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(
          `invalid input: ${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (dependency === rawTask.id) {
        throw new Error(`invalid input: task ${JSON.stringify(rawTask.id)} cannot depend on itself`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(
          `invalid input: task ${JSON.stringify(rawTask.id)} has duplicate dependency ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(rawTask.id);
    tasks.push({ id: rawTask.id, duration: rawTask.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(
          `invalid input: task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
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
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
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
  throw new Error("cycle detected");
}

function createSchedule(tasks: Task[]): Schedule {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
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
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new Error(`cycle detected: ${findCycle(tasksById).join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;
    let bestPredecessorPath: string[] | undefined;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency]!.finish;
      const dependencyPath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPredecessorPath === undefined || comparePaths(dependencyPath, bestPredecessorPath) < 0))
      ) {
        start = dependencyFinish;
        bestPredecessorPath = dependencyPath;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    pathById.set(id, [...(bestPredecessorPath ?? []), id]);
  }

  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id]!.finish;
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

function usageError(message: string): never {
  throw new Error(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0) usageError("missing command");
  if (args[0] !== "plan") usageError(`unknown command: ${args[0]}`);
  if (args.length < 2) usageError("missing input file");
  if (args[1]!.startsWith("-")) usageError(`unknown flag: ${args[1]}`);
  if (args.length > 2) usageError(`unknown argument or flag: ${args[2]}`);

  const inputPath = args[1]!;
  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${JSON.stringify(inputPath)}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(inputPath)}: ${detail}`);
  }

  console.log(JSON.stringify(createSchedule(validateInput(input))));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
