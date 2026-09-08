import { readFileSync } from "node:fs";

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

class InputError extends Error {}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index]!.localeCompare(right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError("tasks must be an array");
  }

  const ids = new Set<string>();
  const tasks: Task[] = tasksValue.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new InputError(`tasks[${index}] must be an object`);
    }

    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new InputError(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new InputError(`duplicate task id: ${raw.id}`);
    }
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new InputError(`task ${raw.id}: duration must be a finite non-negative number`);
    }

    const dependsOnValue = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOnValue)) {
      throw new InputError(`task ${raw.id}: dependsOn must be an array`);
    }

    const seenDependencies = new Set<string>();
    const dependsOn = dependsOnValue.map((dependency, dependencyIndex) => {
      if (typeof dependency !== "string") {
        throw new InputError(
          `task ${raw.id}: dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(`task ${raw.id}: duplicate dependency ${dependency}`);
      }
      seenDependencies.add(dependency);
      return dependency;
    });

    return { id: raw.id, duration: raw.duration, dependsOn };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`task ${task.id}: cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id}: unknown dependency ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort((a, b) => a.localeCompare(b))]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        const start = stack.indexOf(dependency);
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    state.set(id, 2);
    return undefined;
  }

  const ids = tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }

  throw new Error("cycle expected but none found");
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));

  for (const task of tasks) {
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
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new InputError(`cycle detected: ${findCycle(tasks).join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = {};
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = byId.get(id)!;
    const layer = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, layerById.get(dependency)! + 1),
      0,
    );
    layerById.set(id, layer);

    const start = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, earliest[dependency]!.finish),
      0,
    );
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new InputError(`schedule time overflow at task ${id}`);
    }
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);

    const criticalDependencies = task.dependsOn.filter(
      (dependency) => earliest[dependency]!.finish === start,
    );
    if (criticalDependencies.length === 0) {
      pathById.set(id, [id]);
    } else {
      let best = [...pathById.get(criticalDependencies[0]!)!, id];
      for (const dependency of criticalDependencies.slice(1)) {
        const candidate = [...pathById.get(dependency)!, id];
        if (comparePaths(candidate, best) < 0) best = candidate;
      }
      pathById.set(id, best);
    }
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id]!.finish !== totalDuration || dependents.get(id)!.length > 0) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usage(): string {
  return "Usage: bun run src/cli.ts plan INPUT.json";
}

export function main(args: string[]): void {
  if (args.length !== 2) {
    const flag = args.find((argument) => argument.startsWith("-"));
    throw new InputError(flag ? `unknown flag: ${flag}\n${usage()}` : usage());
  }
  if (args[0] !== "plan") {
    throw new InputError(`unknown command: ${args[0]}\n${usage()}`);
  }
  if (args[1]!.startsWith("-")) {
    throw new InputError(`unknown flag: ${args[1]}\n${usage()}`);
  }

  let source: string;
  try {
    source = readFileSync(args[1]!, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read ${args[1]}: ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in ${args[1]}: ${message}`);
  }

  const plan = createPlan(parseTasks(input));
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
