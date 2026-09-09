import { readFile } from "node:fs/promises";

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

function fail(message: string): never {
  throw new Error(message);
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail('"tasks" must be an array');

  const ids = new Set<string>();
  const tasks = tasksValue.map((value, index): Task => {
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${label} must be an object`);
    }

    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) fail(`${label}.dependsOn must be an array`);

    const seenDependencies = new Set<string>();
    const dependsOn = dependencies.map((dependency, dependencyIndex) => {
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
      return dependency;
    });

    return { id: raw.id, duration: raw.duration, dependsOn };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
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

function canonicalizeCycle(cycle: string[]): string[] {
  const nodes = cycle.slice(0, -1);
  let best = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index].localeCompare(nodes[best]) < 0) best = index;
  }
  const rotated = [...nodes.slice(best), ...nodes.slice(0, best)];
  return [...rotated, rotated[0]];
}

function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasks.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const found = visit(dependency);
        if (found) return found;
      } else if (state.get(dependency) === 1) {
        return canonicalizeCycle([...stack.slice(stackIndex.get(dependency)!), dependency]);
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasks.keys()].sort((a, b) => a.localeCompare(b))) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  fail("cycle detected");
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const indegree = new Map<string, number>();

  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort((a, b) => a.localeCompare(b));

  const ready = tasks
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

  if (order.length !== tasks.length) {
    const cycle = findCycle(byId);
    fail(`dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
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
      const candidatePath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPath.length === 0 || compareSequences(candidatePath, bestPath) < 0))
      ) {
        start = dependencyFinish;
        bestPath = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    pathById.set(id, [...bestPath, id]);
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort((a, b) => a.localeCompare(b));

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = pathById.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || compareSequences(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await readFile(args[1], "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read input file: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(validate(input))));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}

