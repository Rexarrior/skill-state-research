#!/usr/bin/env bun

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    fail("tasks must be an array");
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const value = tasksValue[index];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`tasks[${index}] must be an object`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      fail(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      fail(`duplicate task id: ${record.id}`);
    }
    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      fail(`task ${record.id} duration must be a finite non-negative number`);
    }

    const dependsOnValue = record.dependsOn ?? [];
    if (!Array.isArray(dependsOnValue)) {
      fail(`task ${record.id} dependsOn must be an array`);
    }

    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOnValue.length; dependencyIndex++) {
      const dependency = dependsOnValue[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`task ${record.id} dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        fail(`task ${record.id} has duplicate dependency: ${dependency}`);
      }
      if (dependency === record.id) {
        fail(`task ${record.id} cannot depend on itself`);
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(record.id);
    tasks.push({ id: record.id, duration: record.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`task ${task.id} references unknown dependency: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort()] as const),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...dependencies.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]] as const));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) values.sort();

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle?.join(" -> ") ?? "unknown"}`);
  }

  const earliest: Record<string, Timing> = {};
  const paths = new Map<string, string[]>();
  const layerById = new Map<string, number>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let bestPath: string[] = [];
    let layer = 0;

    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidatePath = paths.get(dependency)!;
      if (
        finish > start ||
        (finish === start && compareSequences(candidatePath, bestPath) < 0)
      ) {
        start = finish;
        bestPath = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    earliest[id] = { start, finish: start + task.duration };
    paths.set(id, [...bestPath, id]);
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
  }

  for (const layer of layers) layer.sort();

  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliest[id].finish),
    0,
  );
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = paths.get(id)!;
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(plan(validate(input))));
}

await main();
