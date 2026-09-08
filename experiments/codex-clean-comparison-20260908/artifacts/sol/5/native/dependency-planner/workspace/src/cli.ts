type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

class InputError extends Error {}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function validate(input: unknown): Task[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new InputError(`input must be an object, received ${describe(input)}`);
  }

  const rawTasks = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(rawTasks)) {
    throw new InputError(`tasks must be an array, received ${describe(rawTasks)}`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < rawTasks.length; index++) {
    const raw = rawTasks[index];
    const at = `tasks[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InputError(`${at} must be an object`);
    }

    const value = raw as Record<string, unknown>;
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new InputError(`${at}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) {
      throw new InputError(`duplicate task id: ${JSON.stringify(value.id)}`);
    }
    ids.add(value.id);

    if (
      typeof value.duration !== "number" ||
      !Number.isFinite(value.duration) ||
      value.duration < 0
    ) {
      throw new InputError(`${at}.duration must be a finite non-negative number`);
    }

    const rawDependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new InputError(`${at}.dependsOn must be an array`);
    }

    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        throw new InputError(
          `${at}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`,
        );
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: value.id, duration: value.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new InputError(
          `task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
      if (state.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...tasksById.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort();

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new InputError(`dependency cycle: ${cycle!.join(" -> ")}`);
  }

  const timing = new Map<string, Timing>();
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;

    for (const dependency of task.dependsOn) {
      const dependencyTiming = timing.get(dependency)!;
      start = Math.max(start, dependencyTiming.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    let bestPath: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (timing.get(dependency)!.finish !== start) continue;
      const candidate = [...pathById.get(dependency)!, id];
      if (!bestPath || compareSequences(candidate, bestPath) < 0) bestPath = candidate;
    }
    timing.set(id, { start, finish });
    layerById.set(id, layer);
    pathById.set(id, bestPath!);
    totalDuration = Math.max(totalDuration, finish);
  }

  const layers: string[][] = [];
  for (const [id, layer] of layerById) (layers[layer] ??= []).push(id);
  for (const layer of layers) layer.sort();

  const earliest: Record<string, Timing> = Object.create(null);
  for (const id of [...tasksById.keys()].sort()) {
    earliest[id] = timing.get(id)!;
  }

  let criticalPath: string[] = [];
  for (const id of order) {
    if (timing.get(id)!.finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usage(): string {
  return "usage: bun run src/cli.ts plan INPUT.json";
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) throw new InputError(usage());
  if (args[0] !== "plan") {
    const kind = args[0].startsWith("-") ? "option" : "command";
    throw new InputError(`unknown ${kind}: ${args[0]}\n${usage()}`);
  }
  if (args.length < 2) throw new InputError(usage());
  if (args.length > 2) {
    const unexpectedOption = args.slice(2).find((argument) => argument.startsWith("-"));
    const detail = unexpectedOption
      ? `unknown option: ${unexpectedOption}`
      : `unexpected argument: ${args[2]}`;
    throw new InputError(`${detail}\n${usage()}`);
  }

  const inputPath = args[1];
  if (inputPath.startsWith("-")) {
    throw new InputError(`unknown option: ${inputPath}\n${usage()}`);
  }
  let source: string;
  try {
    source = await Bun.file(inputPath).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read ${JSON.stringify(inputPath)}: ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in ${JSON.stringify(inputPath)}: ${message}`);
  }

  console.log(JSON.stringify(createPlan(validate(input))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
