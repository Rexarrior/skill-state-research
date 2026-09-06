type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

class CliError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): Task[] {
  if (!isRecord(value)) throw new CliError("Invalid input: expected a JSON object");
  if (!Array.isArray(value.tasks)) throw new CliError('Invalid input: "tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(raw)) throw new CliError(`Invalid input: ${location} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new CliError(`Invalid input: ${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new CliError(`Invalid input: duplicate task id "${raw.id}"`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new CliError(`Invalid input: ${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new CliError(`Invalid input: ${location}.dependsOn must be an array`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new CliError(
          `Invalid input: ${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new CliError(`Invalid input: ${location}.dependsOn contains duplicate "${dependency}"`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new CliError(`Invalid input: task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new CliError(`Invalid input: task "${task.id}" references unknown dependency "${dependency}"`);
      }
    }
  }
  return tasks;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);
    const dependencies = [...tasks.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stackPositions.get(dependency)!), dependency];
      }
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...tasks.keys()].sort((a, b) => a.localeCompare(b))) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle].localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function createPlan(tasksList: Task[]): Plan {
  const tasks = new Map(tasksList.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasksList) {
    indegree.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of tasksList) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort((a, b) => a.localeCompare(b));

  const ready = tasksList
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasksList.length) {
    const cycle = findCycle(tasks);
    throw new CliError(`Dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, Timing> = {};
  const criticalById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasks.get(id)!;
    let layer = 0;
    let start = 0;
    let criticalPrefix: string[] = [];
    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency].finish;
      const dependencyPath = criticalById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (criticalPrefix.length === 0 || comparePaths(dependencyPath, criticalPrefix) < 0))
      ) {
        start = dependencyFinish;
        criticalPrefix = dependencyPath;
      }
    }
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    criticalById.set(id, [...criticalPrefix, id]);
  }
  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = criticalById.get(id)!;
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

function usageError(message: string): CliError {
  return new CliError(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.some((argument) => argument.startsWith("-"))) {
    throw usageError(`Unknown flag: ${args.find((argument) => argument.startsWith("-"))}`);
  }
  if (args[0] !== "plan") {
    throw usageError(args[0] ? `Unknown command: ${args[0]}` : "Missing command");
  }
  if (args.length !== 2) throw usageError("Expected exactly one input file");

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not read input file "${args[1]}": ${reason}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid JSON in "${args[1]}": ${reason}`);
  }
  console.log(JSON.stringify(createPlan(parseTasks(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

