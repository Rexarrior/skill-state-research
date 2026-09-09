export interface TaskInput {
  id: string;
  duration: number;
  dependsOn?: string[];
}

export interface PlanResult {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validate(input: unknown): Task[] {
  if (!isRecord(input) || !Array.isArray(input.tasks)) {
    fail('Invalid input: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`Invalid input: ${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`Invalid input: duplicate task id "${raw.id}"`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }
    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) {
      fail(`Invalid input: ${label}.dependsOn must be an array of strings`);
    }
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid input: ${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid input: ${label}.dependsOn contains duplicate "${dependency}"`);
      }
      if (dependency === raw.id) fail(`Invalid input: task "${raw.id}" cannot depend on itself`);
      seenDependencies.add(dependency);
    }
    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependencies] as string[] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`Invalid input: task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
    task.dependsOn.sort(compareIds);
  }
  return tasks;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const position = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    position.set(id, stack.length);
    stack.push(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 1) {
        return [...stack.slice(position.get(dependency)!), dependency];
      }
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    position.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(input: unknown): PlanResult {
  const tasks = validate(input);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const list of dependents.values()) list.sort(compareIds);

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const next = remaining.get(dependent)! - 1;
      remaining.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`Dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    const layer = task.dependsOn.length === 0
      ? 0
      : Math.max(...task.dependsOn.map((dependency) => layerById.get(dependency)!)) + 1;
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    const start = task.dependsOn.length === 0
      ? 0
      : Math.max(...task.dependsOn.map((dependency) => earliest[dependency].finish));
    earliest[id] = { start, finish: start + task.duration };

    const eligible = task.dependsOn.filter((dependency) => earliest[dependency].finish === start);
    let path: string[] = [];
    if (eligible.length > 0) {
      path = pathById.get(eligible[0])!;
      for (const dependency of eligible.slice(1)) {
        const candidate = pathById.get(dependency)!;
        if (comparePaths(candidate, path) < 0) path = candidate;
      }
    }
    pathById.set(id, [...path, id]);
  }

  for (const layer of layers) layer.sort(compareIds);
  const totalDuration = order.length === 0
    ? 0
    : Math.max(...order.map((id) => earliest[id].finish));
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
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
    fail(`Cannot read input file "${args[1]}": ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
