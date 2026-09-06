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

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function comparePaths(a: string[], b: string[]): number {
  const commonLength = Math.min(a.length, b.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareIds(a[index]!, b[index]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(value: unknown): Task[] {
  if (!isObject(value)) throw new Error("input must be a JSON object");
  if (!Array.isArray(value.tasks)) throw new Error('"tasks" must be an array');

  const tasks: Task[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < value.tasks.length; index += 1) {
    const raw = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isObject(raw)) throw new Error(`${location} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (seenIds.has(raw.id)) throw new Error(`duplicate task id: ${JSON.stringify(raw.id)}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) throw new Error(`${location}.dependsOn must be an array`);
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`${location}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    seenIds.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new Error(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      if (!seenIds.has(dependency)) {
        throw new Error(`task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndexes = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndexes.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndexes.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackIndexes.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort(compareIds);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    throw new Error(`dependency cycle: ${cycle?.join(" -> ") ?? "detected"}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  const layerById = new Map<string, number>();
  const bestPathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPrefix: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      const candidatePrefix = bestPathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start && (bestPrefix.length === 0 || comparePaths(candidatePrefix, bestPrefix) < 0))
      ) {
        start = dependencyFinish;
        bestPrefix = candidatePrefix;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    bestPathById.set(id, [...bestPrefix, id]);
    (layers[layer] ??= []).push(id);
  }
  for (const ids of layers) ids.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  let hasCriticalPath = false;
  for (const id of order) {
    if (dependents.get(id)!.length > 0) continue;
    const finish = earliest[id]!.finish;
    const path = bestPathById.get(id)!;
    if (
      !hasCriticalPath ||
      finish > totalDuration ||
      (finish === totalDuration && comparePaths(path, criticalPath) < 0)
    ) {
      totalDuration = finish;
      criticalPath = path;
      hasCriticalPath = true;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export async function run(args: string[]): Promise<Plan> {
  if (args.length !== 2 || args[0] !== "plan") {
    throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  }
  const inputPath = args[1]!;
  if (inputPath.startsWith("-")) throw new Error(`unknown flag: ${inputPath}`);

  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    throw new Error(`cannot read ${JSON.stringify(inputPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return createPlan(validateInput(value));
}

if (import.meta.main) {
  try {
    const plan = await run(Bun.argv.slice(2));
    console.log(JSON.stringify(plan));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
