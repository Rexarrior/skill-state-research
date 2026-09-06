#!/usr/bin/env bun

type InputTask = {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and normalize the parsed input document. */
export function validateInput(value: unknown): InputTask[] {
  if (!isObject(value)) {
    throw new Error("input must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) {
    throw new Error('"tasks" must be an array');
  }

  const tasks: InputTask[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isObject(raw)) {
      throw new Error(`${label} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new Error(`duplicate task id: ${JSON.stringify(raw.id)}`);
    }
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }

    let dependsOn: string[];
    if (raw.dependsOn === undefined) {
      dependsOn = [];
    } else {
      if (!Array.isArray(raw.dependsOn)) {
        throw new Error(`${label}.dependsOn must be an array of strings`);
      }
      dependsOn = [];
      const seen = new Set<string>();
      for (let depIndex = 0; depIndex < raw.dependsOn.length; depIndex++) {
        const dependency = raw.dependsOn[depIndex];
        if (typeof dependency !== "string") {
          throw new Error(`${label}.dependsOn[${depIndex}] must be a string`);
        }
        if (seen.has(dependency)) {
          throw new Error(`${label}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
        }
        if (dependency === raw.id) {
          throw new Error(`task ${JSON.stringify(raw.id)} cannot depend on itself`);
        }
        seen.add(dependency);
        dependsOn.push(dependency);
      }
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(
          `task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index++) {
    const comparison = left[index]!.localeCompare(right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: InputTask[]): string[] {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort((a, b) => a.localeCompare(b))]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
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
    return undefined;
  }

  const ids = tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

/** Produce a deterministic dependency plan from already validated tasks. */
export function createPlan(tasks: InputTask[]): Plan {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
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
    throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const criticalPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = taskById.get(id)!;
    let start = 0;
    let layer = 0;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      if (dependencyFinish > start) start = dependencyFinish;
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    // A critical chain may begin at this task when its start is zero. Compare
    // complete candidate sequences because appending `id` can change how an
    // empty prefix sorts against a zero-duration dependency path.
    let taskPath: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish !== start) continue;
      const candidate = [...criticalPathById.get(dependency)!, id];
      if (taskPath === undefined || compareSequences(candidate, taskPath) < 0) {
        taskPath = candidate;
      }
    }
    criticalPathById.set(id, taskPath!);
  }

  for (const values of layers) values.sort((a, b) => a.localeCompare(b));

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id]!.finish;
    const candidate = criticalPathById.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function plan(value: unknown): Plan {
  return createPlan(validateInput(value));
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan") {
    throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
  }

  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
