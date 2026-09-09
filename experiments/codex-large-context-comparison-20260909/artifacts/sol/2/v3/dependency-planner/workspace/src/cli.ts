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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareSequences(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function parseInput(value: unknown): Task[] {
  if (!isObject(value) || !Array.isArray(value.tasks)) {
    throw new Error('Invalid input: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isObject(raw)) throw new Error(`Invalid input: ${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new Error(`Invalid input: duplicate task id "${raw.id}"`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new Error(`Invalid input: ${label}.dependsOn must be an array of strings`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (const dependency of rawDependencies) {
      if (typeof dependency !== "string") {
        throw new Error(`Invalid input: ${label}.dependsOn must contain only strings`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`Invalid input: ${label}.dependsOn contains duplicate "${dependency}"`);
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
        throw new Error(`Invalid input: task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(`Invalid input: task "${task.id}" references unknown dependency "${dependency}"`);
      }
    }
  }

  return tasks;
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

export function createPlan(tasks: Task[]): Plan {
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
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    throw new Error(`Dependency cycle: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const paths = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    totalDuration = Math.max(totalDuration, finish);

    const candidates = task.dependsOn
      .filter((dependency) => earliest[dependency].finish === start)
      .map((dependency) => [...paths.get(dependency)!, id]);
    paths.set(id, candidates.length === 0 ? [id] : candidates.sort(compareSequences)[0]);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  const criticalCandidates = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => paths.get(id)!);
  const criticalPath = criticalCandidates.length === 0
    ? []
    : criticalCandidates.sort(compareSequences)[0];

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(message: string): never {
  throw new Error(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

export async function main(args: string[]): Promise<void> {
  if (args.length === 0) usageError("Missing command");
  if (args[0].startsWith("-")) usageError(`Unknown flag: ${args[0]}`);
  if (args[0] !== "plan") usageError(`Unknown command: ${args[0]}`);
  if (args.length < 2) usageError("Missing input file");
  if (args[1].startsWith("-")) usageError(`Unknown flag: ${args[1]}`);
  if (args.length > 2) usageError(`Unknown flag or extra argument: ${args[2]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    throw new Error(`Cannot read input file "${args[1]}": ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in "${args[1]}": ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(parseInput(input))));
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
