import { readFile } from "node:fs/promises";

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

export class InputError extends Error {}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

export function validateInput(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const value = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new InputError(`${label} must be an object`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new InputError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      throw new InputError(`duplicate task id: ${record.id}`);
    }
    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      throw new InputError(`${label}.duration must be a finite non-negative number`);
    }

    const dependsOnValue = record.dependsOn ?? [];
    if (!Array.isArray(dependsOnValue)) {
      throw new InputError(`${label}.dependsOn must be an array`);
    }

    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOnValue.length; dependencyIndex++) {
      const dependency = dependsOnValue[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(record.id);
    tasks.push({ id: record.id, duration: record.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`task ${task.id} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort(compareIds)]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  };

  for (const id of [...dependencies.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
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
    const cycle = findCycle(tasks);
    throw new InputError(`dependency cycle: ${cycle!.join(" -> ")}`);
  }

  // A task id may legally be "__proto__" or another Object prototype key.
  const earliest = Object.create(null) as Record<string, Timing>;
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];
  let totalDuration = 0;
  let criticalPath: string[] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let path: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      const candidatePath = [...pathById.get(dependency)!, id];
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (path.length === 0 || compareSequences(candidatePath, path) < 0))
      ) {
        start = dependencyFinish;
        path = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    if (task.dependsOn.length === 0) path = [id];
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, path);
    (layers[layer] ??= []).push(id);

    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || compareSequences(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  for (const values of layers) values.sort(compareIds);
  return { order, layers, earliest, totalDuration, criticalPath };
}

export function plan(input: unknown): Plan {
  return createPlan(validateInput(input));
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) throw new InputError("usage: cli.ts plan INPUT.json");
  if (args[0]!.startsWith("-")) throw new InputError(`unknown flag: ${args[0]}`);
  if (args[0] !== "plan") throw new InputError(`unknown command: ${args[0]}`);
  if (args.length !== 2) {
    const flag = args.slice(1).find((argument) => argument.startsWith("-"));
    if (flag) throw new InputError(`unknown flag: ${flag}`);
    throw new InputError("usage: cli.ts plan INPUT.json");
  }
  if (args[1]!.startsWith("-")) throw new InputError(`unknown flag: ${args[1]}`);

  let source: string;
  try {
    source = await readFile(args[1]!, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read input file: ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON: ${message}`);
  }

  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
