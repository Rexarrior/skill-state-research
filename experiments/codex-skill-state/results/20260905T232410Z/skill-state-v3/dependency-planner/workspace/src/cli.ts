type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

class UserError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): Task[] {
  if (!isRecord(value)) throw new UserError("input must be a JSON object");
  if (!Array.isArray(value.tasks)) throw new UserError("tasks must be an array");

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) throw new UserError(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new UserError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new UserError(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new UserError(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new UserError(`${label}.dependsOn must be an array of strings`);
    }
    const dependencySet = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new UserError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencySet.has(dependency)) {
        throw new UserError(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      dependencySet.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new UserError(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) {
        throw new UserError(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const position = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    position.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(position.get(dependency)!), dependency];
      }
    }

    stack.pop();
    position.delete(id);
    state.set(id, 2);
    return null;
  };

  for (const id of [...byId.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function buildPlan(tasks: Task[]): Plan {
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
    throw new UserError(`dependency cycle: ${cycle?.join(" -> ") ?? "detected"}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPrefix: string[] | null = null;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      const candidatePrefix = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPrefix === null || comparePaths(candidatePrefix, bestPrefix) < 0))
      ) {
        start = dependencyFinish;
        bestPrefix = candidatePrefix;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new UserError(`calculated finish time for task ${id} is not finite`);
    }
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    pathById.set(id, [...(bestPrefix ?? []), id]);
  }

  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = pathById.get(id)!;
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    const command = args[0];
    if (command && command !== "plan") throw new UserError(`unknown command: ${command}`);
    throw new UserError("usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[1].startsWith("-")) throw new UserError(`unknown flag: ${args[1]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`cannot read ${args[1]}: ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`invalid JSON: ${message}`);
  }

  console.log(JSON.stringify(buildPlan(parseTasks(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
