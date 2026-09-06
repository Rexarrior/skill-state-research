import { readFileSync } from "node:fs";

type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Schedule = {
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

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("Input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    return fail('Input field "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const raw = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fail(`${label} must be an object`);
    }

    const record = raw as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      return fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      return fail(`Duplicate task id: ${record.id}`);
    }
    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      return fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependsValue = record.dependsOn ?? [];
    if (!Array.isArray(dependsValue)) {
      return fail(`${label}.dependsOn must be an array`);
    }

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsValue.length; dependencyIndex++) {
      const dependency = dependsValue[dependencyIndex];
      if (typeof dependency !== "string") {
        return fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependency === record.id) {
        return fail(`Task ${record.id} cannot depend on itself`);
      }
      if (seenDependencies.has(dependency)) {
        return fail(`Task ${record.id} has duplicate dependency: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(record.id);
    tasks.push({ id: record.id, duration: record.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        return fail(`Task ${task.id} references unknown dependency: ${dependency}`);
      }
    }
  }

  return tasks;
}

function comparePaths(left: string[], right: string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort((a, b) => a.localeCompare(b))]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        const start = stackIndex.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  };

  const ids = tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function plan(tasks: Task[]): Schedule {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) {
    values.sort((a, b) => a.localeCompare(b));
  }

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    return fail(`Dependency cycle detected: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const bestPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPrefix: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      if (dependencyFinish > start) {
        start = dependencyFinish;
        bestPrefix = bestPathById.get(dependency)!;
      } else if (dependencyFinish === start) {
        const candidate = bestPathById.get(dependency)!;
        if (bestPrefix.length === 0 || comparePaths(candidate, bestPrefix) < 0) {
          bestPrefix = candidate;
        }
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    bestPathById.set(id, [...bestPrefix, id]);
  }

  for (const ids of layers) ids.sort((a, b) => a.localeCompare(b));

  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliest[id].finish),
    0,
  );
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = bestPathById.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function main(args: string[]): void {
  if (args.length !== 2 || args[0] !== "plan") {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }

  let source: string;
  try {
    source = readFileSync(args[1], "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read input file: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON: ${detail}`);
  }

  console.log(JSON.stringify(plan(parseTasks(input))));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
