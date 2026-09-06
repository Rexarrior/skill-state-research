export interface TaskInput {
  id: string;
  duration: number;
  dependsOn?: string[];
}

export interface Plan {
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

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function fail(message: string): never {
  throw new Error(message);
}

export function validateInput(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.tasks)) {
    fail('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const knownIds = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const candidate = input.tasks[index];
    const location = `tasks[${index}]`;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      fail(`${location} must be an object`);
    }

    const raw = candidate as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${location}.id must be a non-empty string`);
    }
    if (knownIds.has(raw.id)) {
      fail(`duplicate task id: ${raw.id}`);
    }
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${location}.duration must be a finite non-negative number`);
    }

    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) {
      fail(`${location}.dependsOn must be an array of strings`);
    }

    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${location}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === raw.id) {
        fail(`task ${raw.id} cannot depend on itself`);
      }
      seenDependencies.add(dependency);
    }

    knownIds.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependencies] as string[] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!knownIds.has(dependency)) {
        fail(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
    task.dependsOn.sort(compareIds);
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);

    for (const dependency of byId.get(id)!.dependsOn) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        const cycleStart = stack.lastIndexOf(dependency);
        return [...stack.slice(cycleStart), dependency];
      }
    }

    stack.pop();
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
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
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
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
    fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = {};
  const bestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    let pathPrefix: string[] = [];
    let hasPathPrefix = false;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency].finish;
      const dependencyPath = bestPath.get(dependency)!;
      if (
        !hasPathPrefix ||
        dependencyFinish > start ||
        (dependencyFinish === start &&
          comparePaths([...dependencyPath, id], [...pathPrefix, id]) < 0)
      ) {
        start = dependencyFinish;
        pathPrefix = dependencyPath;
        hasPathPrefix = true;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    bestPath.set(id, [...pathPrefix, id]);
  }

  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = bestPath.get(id)!;
    if (
      criticalPath.length === 0 ||
      finish > totalDuration ||
      (finish === totalDuration && comparePaths(path, criticalPath) < 0)
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function planInput(value: unknown): Plan {
  return createPlan(validateInput(value));
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) fail("usage: dependency-planner plan INPUT.json");
  if (args[0] !== "plan") fail(`unknown command: ${args[0]}`);
  if (args.length < 2) fail("usage: dependency-planner plan INPUT.json");
  if (args.length > 2) {
    const flag = args.slice(2).find((argument) => argument.startsWith("-"));
    fail(flag ? `unknown flag: ${flag}` : "plan accepts exactly one input file");
  }
  if (args[1].startsWith("-")) fail(`unknown flag: ${args[1]}`);

  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${args[1]}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in ${args[1]}: ${detail}`);
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
