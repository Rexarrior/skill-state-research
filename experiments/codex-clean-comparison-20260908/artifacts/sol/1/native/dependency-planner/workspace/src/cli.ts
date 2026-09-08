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

type JsonObject = Record<string, unknown>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareStrings(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and normalize parsed input. */
export function parseTasks(input: unknown): Task[] {
  if (!isObject(input)) {
    throw new Error("input must be a JSON object");
  }
  if (!Array.isArray(input.tasks)) {
    throw new Error('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const value = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isObject(value)) {
      throw new Error(`${label} must be an object`);
    }
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) {
      throw new Error(`duplicate task id: ${JSON.stringify(value.id)}`);
    }
    if (
      typeof value.duration !== "number" ||
      !Number.isFinite(value.duration) ||
      value.duration < 0
    ) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(
          `${label}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(value.id);
    tasks.push({ id: value.id, duration: value.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

function canonicalizeCycle(cycle: string[]): string[] {
  const body = cycle.slice(0, -1);
  let best = body;
  for (let offset = 1; offset < body.length; offset += 1) {
    const candidate = body.slice(offset).concat(body.slice(0, offset));
    if (comparePaths(candidate, best) < 0) best = candidate;
  }
  return best.concat(best[0]!);
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort(compareStrings)]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of dependencies.get(id)!) {
      if (!state.has(dependency)) {
        const result = visit(dependency);
        if (result) return result;
      } else if (state.get(dependency) === 1) {
        const start = stack.lastIndexOf(dependency);
        return canonicalizeCycle(stack.slice(start).concat(dependency));
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...dependencies.keys()].sort(compareStrings)) {
    if (!state.has(id)) {
      const result = visit(id);
      if (result) return result;
    }
  }
  throw new Error("cycle detected");
}

/** Build a deterministic schedule, or throw if the dependency graph is cyclic. */
export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const list of dependents.values()) list.sort(compareStrings);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareStrings);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareStrings);
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new Error(`dependency cycle: ${findCycle(tasks).join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const timingById = new Map<string, { start: number; finish: number }>();
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    let predecessorPath: string[] = [];

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = timingById.get(dependency)!.finish;
      const dependencyPath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (predecessorPath.length === 0 ||
            comparePaths(dependencyPath.concat(id), predecessorPath.concat(id)) < 0))
      ) {
        start = dependencyFinish;
        predecessorPath = dependencyPath;
      }
    }

    layerById.set(id, layer);
    timingById.set(id, { start, finish: start + task.duration });
    pathById.set(id, predecessorPath.concat(id));
  }

  const layerCount = tasks.length === 0 ? 0 : Math.max(...layerById.values()) + 1;
  const layers = Array.from({ length: layerCount }, () => [] as string[]);
  for (const id of [...byId.keys()].sort(compareStrings)) {
    layers[layerById.get(id)!]!.push(id);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  for (const id of [...byId.keys()].sort(compareStrings)) {
    earliest[id] = timingById.get(id)!;
  }

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of [...byId.keys()].sort(compareStrings)) {
    const finish = timingById.get(id)!.finish;
    const path = pathById.get(id)!;
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(message: string): never {
  throw new Error(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

export async function run(args: string[]): Promise<Plan> {
  if (args.length === 0) usageError("missing command");
  if (args[0]!.startsWith("-")) usageError(`unknown flag: ${args[0]}`);
  if (args[0] !== "plan") usageError(`unknown command: ${args[0]}`);
  if (args.length < 2) usageError("missing input file");
  if (args[1]!.startsWith("-")) usageError(`unknown flag: ${args[1]}`);
  if (args.length > 2) usageError(`unexpected argument or flag: ${args[2]}`);

  const inputPath = args[1]!;
  let source: string;
  try {
    source = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${JSON.stringify(inputPath)}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(inputPath)}: ${detail}`);
  }
  return createPlan(parseTasks(input));
}

if (import.meta.main) {
  try {
    const plan = await run(Bun.argv.slice(2));
    console.log(JSON.stringify(plan));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
