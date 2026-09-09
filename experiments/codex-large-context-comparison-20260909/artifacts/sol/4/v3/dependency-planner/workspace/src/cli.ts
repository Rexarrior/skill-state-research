#!/usr/bin/env bun

export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return left.length - right.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(input: unknown): Task[] {
  if (!isRecord(input) || !Array.isArray(input.tasks)) {
    throw new Error('schema error: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) throw new Error(`schema error: ${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`schema error: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new Error(`schema error: duplicate task id "${raw.id}"`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`schema error: ${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new Error(`schema error: ${label}.dependsOn must be an array of strings`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`schema error: ${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`schema error: ${label}.dependsOn contains duplicate "${dependency}"`);
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
        throw new Error(`schema error: task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(`schema error: task "${task.id}" references unknown dependency "${dependency}"`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
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
  };

  for (const id of [...dependencies.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
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
    throw new Error(`cycle detected: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const criticalEndingAt = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    totalDuration = Math.max(totalDuration, finish);

    const criticalPredecessors = task.dependsOn
      .filter((dependency) => earliest[dependency]!.finish === start)
      .map((dependency) => criticalEndingAt.get(dependency)!);
    criticalPredecessors.sort(compareSequences);
    criticalEndingAt.set(id, criticalPredecessors.length === 0 ? [id] : [...criticalPredecessors[0]!, id]);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort();

  const criticalCandidates = order
    .filter((id) => earliest[id]!.finish === totalDuration)
    .map((id) => criticalEndingAt.get(id)!);
  criticalCandidates.sort(compareSequences);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalCandidates[0] ?? [],
  };
}

export async function run(args: string[]): Promise<Plan> {
  if (args.length === 0) throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") throw new Error(`unknown command "${args[0]}"`);
  if (args.length !== 2) {
    const extra = args.slice(1).find((argument) => argument.startsWith("-"));
    if (extra) throw new Error(`unknown flag "${extra}"`);
    throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[1]!.startsWith("-")) throw new Error(`unknown flag "${args[1]}"`);

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read "${args[1]}": ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON: ${detail}`);
  }
  return createPlan(validateInput(input));
}

if (import.meta.main) {
  try {
    const plan = await run(Bun.argv.slice(2));
    console.log(JSON.stringify(plan));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  }
}
