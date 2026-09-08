#!/usr/bin/env bun

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) fail("Invalid schema: root must be an object");
  if (!Array.isArray(input.tasks)) fail("Invalid schema: tasks must be an array");

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`Invalid schema: ${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid schema: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`Invalid schema: duplicate task id ${JSON.stringify(raw.id)}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`Invalid schema: ${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`Invalid schema: ${label}.dependsOn must be an array`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid schema: ${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid schema: ${label}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`);
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
        fail(`Invalid schema: task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        fail(`Invalid schema: task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
      }
    }
  }

  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(positions.get(dependency)), dependency];
      }
    }

    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of tasks.map((task) => task.id).sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function makePlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
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
    fail(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const bestPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPath: string[] | undefined;

    if (task.dependsOn.length === 0) {
      bestPath = [id];
    } else {
      for (const dependency of task.dependsOn) {
        const dependencyFinish = earliest[dependency].finish;
        const candidate = [...bestPathById.get(dependency)!, id];
        if (
          dependencyFinish > start ||
          (dependencyFinish === start && (bestPath === undefined || compareSequences(candidate, bestPath) < 0))
        ) {
          start = dependencyFinish;
          bestPath = candidate;
        }
        layer = Math.max(layer, layerById.get(dependency)! + 1);
      }
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    bestPathById.set(id, bestPath!);
  }

  for (const ids of layers) ids.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidate = bestPathById.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration && (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function plan(input: unknown): Plan {
  return makePlan(validate(input));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`Cannot read input file ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof CliError ? error.message : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

