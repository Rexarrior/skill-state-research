type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Schedule = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    const comparison = compareIds(a[i]!, b[i]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(value: unknown): Task[] {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new Error('input must be an object with a "tasks" array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new Error(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    if (raw.dependsOn !== undefined && !Array.isArray(raw.dependsOn)) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOn.length; dependencyIndex++) {
      const dependency = dependsOn[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === raw.id) throw new Error(`task ${raw.id} cannot depend on itself`);
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`task ${task.id} depends on unknown task: ${dependency}`);
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

    const dependencies = [...byId.get(id)!.dependsOn].sort(compareIds);
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

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function plan(tasks: Task[]): Schedule {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
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
    throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let predecessorPath: string[] | undefined;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const candidatePath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (predecessorPath === undefined || comparePaths(candidatePath, predecessorPath) < 0))
      ) {
        start = dependencyFinish;
        predecessorPath = candidatePath;
      }
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...(predecessorPath ?? []), id]);
    (layers[layer] ??= []).push(id);
  }

  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id]!.finish;
    const path = pathById.get(id)!;
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

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    throw new Error("usage: bun run src/cli.ts plan INPUT.json (unknown command or flags)");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    throw new Error(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(plan(validateInput(input))));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

