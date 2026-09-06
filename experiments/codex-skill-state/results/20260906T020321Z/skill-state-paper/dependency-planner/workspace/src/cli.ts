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

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < root.tasks.length; index++) {
    const raw = root.tasks[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }

    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(item.id)) fail(`duplicate task id: ${JSON.stringify(item.id)}`);
    ids.add(item.id);

    if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(dependencies)) fail(`${label}.dependsOn must be an array`);
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let depIndex = 0; depIndex < dependencies.length; depIndex++) {
      const dependency = dependencies[depIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${depIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: item.id, duration: item.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
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
    if (values[middle].localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, number>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
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
    return undefined;
  };

  for (const id of [...dependencies.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function buildPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const children of dependents.values()) children.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of dependents.get(id)!) {
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) insertSorted(ready, child);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPath: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      if (dependencyFinish > start) {
        start = dependencyFinish;
        bestPath = pathById.get(dependency)!;
      } else if (dependencyFinish === start) {
        const candidate = pathById.get(dependency)!;
        if (bestPath.length === 0 || compareSequences(candidate, bestPath) < 0) bestPath = candidate;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    pathById.set(id, [...bestPath, id]);
  }

  for (const currentLayer of layers) currentLayer.sort();
  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id].finish), 0);
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`unknown command: ${JSON.stringify(args[0])}`);
  if (args.length < 2) fail("missing input file");
  if (args.length > 2) fail(`unknown argument or flag: ${JSON.stringify(args[2])}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`cannot read ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(buildPlan(parseTasks(input))));
}

await main();
