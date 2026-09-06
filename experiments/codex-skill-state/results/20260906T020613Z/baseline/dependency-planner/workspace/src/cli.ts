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

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function comparePaths(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareStrings(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(value: unknown): Task[] {
  if (!isObject(value)) {
    throw new InputError("input must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) {
    throw new InputError('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index += 1) {
    const candidate = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isObject(candidate)) {
      throw new InputError(`${location} must be an object`);
    }
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new InputError(`${location}.id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) {
      throw new InputError(`duplicate task id: ${JSON.stringify(candidate.id)}`);
    }
    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      throw new InputError(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = candidate.dependsOn === undefined ? [] : candidate.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new InputError(`${location}.dependsOn must be an array of strings`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(
          `${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(
          `${location}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`,
        );
      }
      if (dependency === candidate.id) {
        throw new InputError(`task ${JSON.stringify(candidate.id)} cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(candidate.id);
    tasks.push({
      id: candidate.id,
      duration: candidate.duration,
      dependsOn: dependencies,
    });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new InputError(
          `task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, "visiting");
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort(compareStrings);
    for (const dependency of dependencies) {
      if (state.get(dependency) === "visiting") {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
      if (state.get(dependency) !== "visited") {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, "visited");
    return undefined;
  };

  for (const id of [...byId.keys()].sort(compareStrings)) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function createPlan(input: unknown): Plan {
  const tasks = validateInput(input);
  const cycle = findCycle(tasks);
  if (cycle) {
    throw new InputError(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
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
      const count = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(compareStrings);
      }
    }
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, { start: number; finish: number }> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    let bestPath: string[] | undefined;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency].finish;
      const candidatePath = [...pathById.get(dependency)!, id];
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPath === undefined || comparePaths(candidatePath, bestPath) < 0))
      ) {
        start = dependencyFinish;
        bestPath = candidatePath;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    Object.defineProperty(earliest, id, {
      value: { start, finish: start + task.duration },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    pathById.set(id, bestPath ?? [id]);
  }
  for (const layer of layers) layer.sort(compareStrings);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
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

function usage(): string {
  return "Usage: bun run src/cli.ts plan INPUT.json";
}

export async function runCli(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error(`Error: missing command. ${usage()}`);
    return 1;
  }
  if (args[0].startsWith("-")) {
    console.error(`Error: unknown flag ${JSON.stringify(args[0])}. ${usage()}`);
    return 1;
  }
  if (args[0] !== "plan") {
    console.error(`Error: unknown command ${JSON.stringify(args[0])}. ${usage()}`);
    return 1;
  }
  if (args.length < 2) {
    console.error(`Error: missing input file. ${usage()}`);
    return 1;
  }
  if (args.length > 2) {
    const extra = args[2];
    const kind = extra.startsWith("-") ? "unknown flag" : "unexpected argument";
    console.error(`Error: ${kind} ${JSON.stringify(extra)}. ${usage()}`);
    return 1;
  }
  if (args[1].startsWith("-")) {
    console.error(`Error: unknown flag ${JSON.stringify(args[1])}. ${usage()}`);
    return 1;
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Error: cannot read ${JSON.stringify(args[1])}: ${detail}`);
    return 1;
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Error: invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
    return 1;
  }

  try {
    console.log(JSON.stringify(createPlan(input)));
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${detail}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
