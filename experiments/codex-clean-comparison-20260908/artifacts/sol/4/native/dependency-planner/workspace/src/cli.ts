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

class InputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) throw new InputError("input must be a JSON object");
  if (!Array.isArray(input.tasks)) throw new InputError('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) throw new InputError(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new InputError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new InputError(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new InputError(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) throw new InputError(`${label}.dependsOn must be an array`);
    const dependsOn: string[] = [];
    const seen = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seen.has(dependency)) {
        throw new InputError(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      seen.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new InputError(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id} depends on unknown task: ${dependency}`);
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
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
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
  };

  for (const id of tasks.map((task) => task.id).sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    throw new InputError(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest = Object.create(null) as Record<string, Timing>;
  const paths = new Map<string, string[]>();
  const layerById = new Map<string, number>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    let ownPath: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (earliest[dependency].finish !== start) continue;
      const candidate = [...paths.get(dependency)!, id];
      if (ownPath === undefined || comparePaths(candidate, ownPath) < 0) ownPath = candidate;
    }
    earliest[id] = { start, finish: start + task.duration };
    paths.set(id, ownPath!);
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidate = paths.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration && (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    throw new InputError("usage: bun run src/cli.ts plan INPUT.json");
  }

  let source: string;
  try {
    source = await readFile(args[1], "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read ${args[1]}: ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON: ${message}`);
  }
  process.stdout.write(`${JSON.stringify(createPlan(input))}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
}
