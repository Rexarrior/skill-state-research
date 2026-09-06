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

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input) || !Array.isArray(input.tasks)) {
    fail('input must be an object with a "tasks" array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const value = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(value)) {
      fail(`${label} must be an object`);
    }
    if (typeof value.id !== "string" || value.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) {
      fail(`duplicate task id: ${JSON.stringify(value.id)}`);
    }
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`${label}.dependsOn must be an array of unique strings`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`);
      }
      if (dependency === value.id) {
        fail(`task ${JSON.stringify(value.id)} cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(value.id);
    tasks.push({ id: value.id, duration: value.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`);
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

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
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

function buildPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) values.sort();

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
    fail(`dependency cycle: ${cycle ? cycle.join(" -> ") : "detected"}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const bestPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    let prefix: string[] = [];
    const criticalDependencies = task.dependsOn
      .filter((dependency) => earliest[dependency].finish === start)
      .map((dependency) => bestPathById.get(dependency)!)
      .sort(comparePaths);
    if (criticalDependencies.length > 0) prefix = criticalDependencies[0];

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    bestPathById.set(id, [...prefix, id]);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort();

  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id].finish), 0);
  const candidates = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => bestPathById.get(id)!)
    .sort(comparePaths);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: candidates[0] ?? [],
  };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
  }

  console.log(JSON.stringify(buildPlan(validate(input))));
}

await main();
