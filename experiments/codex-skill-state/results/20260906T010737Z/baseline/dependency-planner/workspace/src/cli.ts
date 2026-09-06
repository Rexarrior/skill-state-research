import { readFileSync } from "node:fs";

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePaths(left: string[], right: string[]): number {
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

function describe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function validateInput(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new Error('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const rawTask = tasksValue[index];
    const location = `tasks[${index}]`;
    if (typeof rawTask !== "object" || rawTask === null || Array.isArray(rawTask)) {
      throw new Error(`${location} must be an object`);
    }

    const raw = rawTask as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new Error(`duplicate task id ${describe(raw.id)}`);
    }
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    const dependsOnValue = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOnValue)) {
      throw new Error(`${location}.dependsOn must be an array of strings`);
    }

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOnValue.length; dependencyIndex += 1) {
      const dependency = dependsOnValue[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`${location}.dependsOn contains duplicate id ${describe(dependency)}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`task ${describe(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(`task ${describe(task.id)} references unknown dependency ${describe(dependency)}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const sortedIds = [...tasksById.keys()].sort(compareIds);

  for (const start of sortedIds) {
    if ((state.get(start) ?? 0) !== 0) continue;

    const path: string[] = [start];
    const pathIndexes = new Map<string, number>([[start, 0]]);
    const stack: Array<{ id: string; dependencies: string[]; next: number }> = [
      { id: start, dependencies: [...tasksById.get(start)!.dependsOn].sort(compareIds), next: 0 },
    ];
    state.set(start, 1);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next >= frame.dependencies.length) {
        state.set(frame.id, 2);
        pathIndexes.delete(frame.id);
        path.pop();
        stack.pop();
        continue;
      }

      const dependency = frame.dependencies[frame.next++]!;
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 1) {
        const cycleStart = pathIndexes.get(dependency)!;
        return [...path.slice(cycleStart), dependency];
      }
      if (dependencyState === 0) {
        state.set(dependency, 1);
        pathIndexes.set(dependency, path.length);
        path.push(dependency);
        stack.push({
          id: dependency,
          dependencies: [...tasksById.get(dependency)!.dependsOn].sort(compareIds),
          next: 0,
        });
      }
    }
  }

  throw new Error("cycle detected");
}

export function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) values.sort(compareIds);

  const ready = [...tasksById.keys()].filter((id) => indegree.get(id) === 0).sort(compareIds);
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

  if (order.length !== tasks.length) {
    throw new Error(`dependency cycle detected: ${findCycle(tasksById).join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const times = new Map<string, { start: number; finish: number }>();
  const criticalPaths = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;
    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      start = Math.max(start, times.get(dependency)!.finish);
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new Error(`computed finish time for task ${describe(id)} is not finite`);
    }

    let bestPath: string[] | undefined;
    if (task.dependsOn.length === 0) {
      bestPath = [id];
    } else {
      for (const dependency of task.dependsOn) {
        if (times.get(dependency)!.finish !== start) continue;
        const candidate = [...criticalPaths.get(dependency)!, id];
        if (bestPath === undefined || comparePaths(candidate, bestPath) < 0) bestPath = candidate;
      }
    }

    layerById.set(id, layer);
    if (layers[layer] === undefined) layers[layer] = [];
    layers[layer]!.push(id);
    times.set(id, { start, finish });
    criticalPaths.set(id, bestPath!);
  }

  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  for (const { finish } of times.values()) totalDuration = Math.max(totalDuration, finish);

  let criticalPath: string[] = [];
  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if (times.get(id)!.finish !== totalDuration) continue;
    const candidate = criticalPaths.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  const earliest = Object.create(null) as Record<string, { start: number; finish: number }>;
  for (const id of [...tasksById.keys()].sort(compareIds)) earliest[id] = times.get(id)!;

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(message: string): never {
  throw new Error(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

export function run(args: string[]): Plan {
  if (args.some((argument) => argument.startsWith("-"))) {
    usageError(`unknown flag: ${args.find((argument) => argument.startsWith("-"))}`);
  }
  if (args[0] !== "plan") {
    usageError(args[0] === undefined ? "missing command" : `unknown command: ${args[0]}`);
  }
  if (args.length < 2) usageError("missing input file");
  if (args.length > 2) usageError(`unexpected argument: ${args[2]}`);

  let source: string;
  try {
    source = readFileSync(args[1]!, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read input file ${describe(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${describe(args[1])}: ${detail}`);
  }

  return createPlan(validateInput(input));
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
