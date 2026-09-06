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

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareIds(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
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

export function validateInput(input: unknown): Task[] {
  if (!isRecord(input)) {
    throw new InputError("input must be a JSON object");
  }
  if (!Array.isArray(input.tasks)) {
    throw new InputError('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const knownIds = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const rawTask = input.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(rawTask)) {
      throw new InputError(`${location} must be an object`);
    }
    if (typeof rawTask.id !== "string" || rawTask.id.length === 0) {
      throw new InputError(`${location}.id must be a non-empty string`);
    }
    if (knownIds.has(rawTask.id)) {
      throw new InputError(`duplicate task id ${JSON.stringify(rawTask.id)}`);
    }
    if (
      typeof rawTask.duration !== "number" ||
      !Number.isFinite(rawTask.duration) ||
      rawTask.duration < 0
    ) {
      throw new InputError(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = Object.hasOwn(rawTask, "dependsOn") ? rawTask.dependsOn : [];
    if (!Array.isArray(rawDependencies)) {
      throw new InputError(`${location}.dependsOn must be an array`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(
          `${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(
          `${location}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    knownIds.add(rawTask.id);
    tasks.push({ id: rawTask.id, duration: rawTask.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!knownIds.has(dependency)) {
        throw new InputError(
          `task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
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
  }

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }

  throw new Error("cycle detection failed");
}

export function createPlan(tasks: readonly Task[]): Plan {
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
  for (const taskDependents of dependents.values()) taskDependents.sort(compareIds);

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
    throw new InputError(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const timings = new Map<string, { start: number; finish: number }>();
  const criticalPathTo = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;
    let predecessorPath: string[] = [];

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = timings.get(dependency)!.finish;
      const candidatePath = criticalPathTo.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (predecessorPath.length === 0 || comparePaths(candidatePath, predecessorPath) < 0))
      ) {
        start = dependencyFinish;
        predecessorPath = candidatePath;
      }
    }

    const finish = start + task.duration;
    layerById.set(id, layer);
    timings.set(id, { start, finish });
    criticalPathTo.set(id, [...predecessorPath, id]);
    if (!layers[layer]) layers[layer] = [];
    layers[layer]!.push(id);
  }

  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = timings.get(id)!.finish;
    const candidatePath = criticalPathTo.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || comparePaths(candidatePath, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = candidatePath;
    }
  }

  const earliest = Object.create(null) as Record<string, { start: number; finish: number }>;
  for (const id of order) earliest[id] = timings.get(id)!;

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(message: string): never {
  throw new InputError(`${message}. Usage: bun run src/cli.ts plan INPUT.json`);
}

export async function run(args: readonly string[]): Promise<void> {
  if (args.length === 0) usageError("missing command");
  if (args[0] !== "plan") {
    if (args[0]!.startsWith("-")) usageError(`unknown flag ${JSON.stringify(args[0])}`);
    usageError(`unknown command ${JSON.stringify(args[0])}`);
  }
  const unknownFlag = args.slice(1).find((argument) => argument.startsWith("-"));
  if (unknownFlag) usageError(`unknown flag ${JSON.stringify(unknownFlag)}`);
  if (args.length !== 2) usageError("the plan command requires exactly one input file");

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
  }

  const result = createPlan(validateInput(input));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
