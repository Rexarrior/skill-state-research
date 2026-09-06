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

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const comparison = compareStrings(a[i]!, b[i]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(input: unknown): Task[] {
  if (!isRecord(input)) throw new Error("input must be a JSON object");
  if (!Array.isArray(input.tasks)) throw new Error('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(raw)) throw new Error(`${location} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new Error(`duplicate task id: ${JSON.stringify(raw.id)}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) throw new Error(`${location}.dependsOn must be an array`);
    const dependencySet = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencySet.has(dependency)) {
        throw new Error(`${location}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
      }
      dependencySet.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new Error(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      if (!ids.has(dependency)) {
        throw new Error(`task ${JSON.stringify(task.id)} depends on unknown id ${JSON.stringify(dependency)}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);
    const dependencies = [...byId.get(id)!.dependsOn].sort(compareStrings);
    for (const dependency of dependencies) {
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

  for (const id of [...byId.keys()].sort(compareStrings)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const children of dependents.values()) children.sort(compareStrings);

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort(compareStrings);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareStrings);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  const bestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    let prefix: string[] = [];
    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency]!.finish;
      const dependencyPath = bestPath.get(dependency)!;
      if (dependencyFinish > start || (dependencyFinish === start && comparePaths(dependencyPath, prefix) < 0)) {
        start = dependencyFinish;
        prefix = dependencyPath;
      }
    }
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    bestPath.set(id, [...prefix, id]);
  }
  for (const layer of layers) layer.sort(compareStrings);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id]!.finish;
    const path = bestPath.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration && (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function planInput(input: unknown): Plan {
  return createPlan(validateInput(input));
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error("missing command; usage: plan INPUT.json");
  if (args[0] !== "plan") throw new Error(`unknown command: ${args[0]}`);
  const unknownFlag = args.slice(1).find((argument) => argument.startsWith("-"));
  if (unknownFlag) throw new Error(`unknown flag: ${unknownFlag}`);
  if (args.length !== 2) throw new Error("usage: plan INPUT.json");

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${JSON.stringify(args[1])}: ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(args[1])}: ${message}`);
  }
  console.log(JSON.stringify(planInput(input)));
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
