type RawTask = {
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

class CliError extends Error {}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIds(a[index]!, b[index]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateInput(value: unknown): RawTask[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("Invalid input: the top-level value must be an object");
  }

  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.tasks)) {
    throw new CliError(`Invalid input: \"tasks\" must be an array (received ${describe(input.tasks)})`);
  }

  const tasks: RawTask[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const valueAtIndex = input.tasks[index];
    const location = `tasks[${index}]`;
    if (typeof valueAtIndex !== "object" || valueAtIndex === null || Array.isArray(valueAtIndex)) {
      throw new CliError(`Invalid input: ${location} must be an object`);
    }

    const task = valueAtIndex as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new CliError(`Invalid input: ${location}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) {
      throw new CliError(`Invalid input: duplicate task id \"${task.id}\"`);
    }
    ids.add(task.id);

    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      throw new CliError(`Invalid input: ${location}.duration must be a finite non-negative number`);
    }

    const dependsOn = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependsOn)) {
      throw new CliError(`Invalid input: ${location}.dependsOn must be an array of strings`);
    }

    const dependencyIds: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOn.length; dependencyIndex += 1) {
      const dependency = dependsOn[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new CliError(
          `Invalid input: ${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new CliError(
          `Invalid input: ${location}.dependsOn contains duplicate id \"${dependency}\"`,
        );
      }
      seenDependencies.add(dependency);
      dependencyIds.push(dependency);
    }

    tasks.push({ id: task.id, duration: task.duration, dependsOn: dependencyIds });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new CliError(`Invalid input: task \"${task.id}\" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new CliError(
          `Invalid input: task \"${task.id}\" references unknown dependency \"${dependency}\"`,
        );
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: ReadonlyMap<string, RawTask>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...tasksById.keys()].sort(compareIds)) {
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
    if (compareIds(values[middle]!, value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function createPlan(tasks: RawTask[]): Plan {
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
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new CliError(`Dependency cycle detected: ${cycle!.join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    let predecessorPath: string[] | null = null;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      start = Math.max(start, dependencyFinish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish !== start) continue;
      const candidate = pathById.get(dependency)!;
      if (predecessorPath === null || comparePaths(candidate, predecessorPath) < 0) {
        predecessorPath = candidate;
      }
    }

    const finish = start + task.duration;
    const path = [...(predecessorPath ?? []), id];
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, path);

    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))
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
  for (const ids of layers) ids.sort(compareIds);

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usage(): string {
  return "Usage: bun run src/cli.ts plan INPUT.json";
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
    const detail = args[0] && args[0] !== "plan" ? `Unknown command: ${args[0]}` : "Invalid arguments";
    throw new CliError(`${detail}\n${usage()}`);
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not read input file \"${args[1]}\": ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid JSON in \"${args[1]}\": ${message}`);
  }

  console.log(JSON.stringify(createPlan(validateInput(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
