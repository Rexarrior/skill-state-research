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

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  const commonLength = Math.min(a.length, b.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareIds(a[index], b[index]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): Task[] {
  if (!isRecord(value)) {
    throw new InputError("input must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) {
    throw new InputError('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index += 1) {
    const rawTask = value.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(rawTask)) {
      throw new InputError(`${location} must be an object`);
    }
    if (typeof rawTask.id !== "string" || rawTask.id.length === 0) {
      throw new InputError(`${location}.id must be a non-empty string`);
    }
    if (ids.has(rawTask.id)) {
      throw new InputError(`duplicate task id: ${rawTask.id}`);
    }
    if (
      typeof rawTask.duration !== "number" ||
      !Number.isFinite(rawTask.duration) ||
      rawTask.duration < 0
    ) {
      throw new InputError(`${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = rawTask.dependsOn === undefined ? [] : rawTask.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new InputError(`${location}.dependsOn must be an array of strings`);
    }
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(
          `${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(`duplicate dependency ${dependency} in task ${rawTask.id}`);
      }
      if (dependency === rawTask.id) {
        throw new InputError(`task ${rawTask.id} cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(rawTask.id);
    tasks.push({ id: rawTask.id, duration: rawTask.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, "visiting");
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if (state.get(dependency) === "visiting") {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
      if (state.get(dependency) !== "visited") {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, "visited");
    return null;
  }

  for (const id of [...byId.keys()].sort(compareIds)) {
    if (state.has(id)) continue;
    const cycle = visit(id);
    if (cycle !== null) return cycle;
  }
  return null;
}

function createPlan(tasks: Task[]): Plan {
  const cycle = findCycle(tasks);
  if (cycle !== null) {
    throw new InputError(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
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

  const layerById = new Map<string, number>();
  const timingById = new Map<string, Timing>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];
  let totalDuration = 0;

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
          (predecessorPath.length === 0 || comparePaths(dependencyPath, predecessorPath) < 0))
      ) {
        start = dependencyFinish;
        predecessorPath = dependencyPath;
      }
    }

    const finish = start + task.duration;
    layerById.set(id, layer);
    timingById.set(id, { start, finish });
    pathById.set(id, [...predecessorPath, id]);
    (layers[layer] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
  }

  for (const layer of layers) layer.sort(compareIds);

  let criticalPath: string[] = [];
  for (const id of order) {
    if (timingById.get(id)!.finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  const earliest: Record<string, Timing> = {};
  for (const id of [...byId.keys()].sort(compareIds)) {
    earliest[id] = timingById.get(id)!;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.some((argument) => argument.startsWith("-"))) {
    const flag = args.find((argument) => argument.startsWith("-"))!;
    throw new InputError(`unknown flag: ${flag}`);
  }
  if (args.length > 0 && args[0] !== "plan") {
    throw new InputError(`unknown command: ${args[0]}`);
  }
  if (args.length !== 2) {
    throw new InputError("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read ${args[1]}: ${detail}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in ${args[1]}: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(parseTasks(value))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
