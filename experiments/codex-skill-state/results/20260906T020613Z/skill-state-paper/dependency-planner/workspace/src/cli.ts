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

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const comparison = compareIds(a[i], b[i]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`input must be an object, got ${describe(input)}`);
  }

  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.tasks)) {
    throw new Error(`tasks must be an array, got ${describe(record.tasks)}`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < record.tasks.length; index += 1) {
    const value = record.tasks[index];
    const location = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${location} must be an object`);
    }
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) {
      throw new Error(`duplicate task id: ${JSON.stringify(task.id)}`);
    }
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }
    const dependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new Error(`${location}.dependsOn must be an array of strings`);
    }
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`${location}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`);
      }
      seenDependencies.add(dependency);
    }
    ids.add(task.id);
    tasks.push({ id: task.id, duration: task.duration, dependsOn: [...dependencies] as string[] });
  }

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`tasks[${index}].dependsOn cannot contain its own id ${JSON.stringify(task.id)}`);
      }
      if (!ids.has(dependency)) {
        throw new Error(`tasks[${index}].dependsOn references unknown id ${JSON.stringify(dependency)}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort(compareIds)]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(positions.get(dependency)), dependency];
      }
    }
    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of tasks.map((task) => task.id).sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) values.sort(compareIds);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    throw new Error(`dependency cycle: ${cycle?.join(" -> ") ?? "detected"}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPath: string[] | null = null;
    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidatePath = pathById.get(dependency)!;
      if (
        bestPath === null ||
        finish > start ||
        (finish === start && comparePaths(candidatePath, bestPath) < 0)
      ) {
        start = finish;
        bestPath = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    pathById.set(id, [...(bestPath ?? []), id]);
    if (layers[layer] === undefined) layers[layer] = [];
    layers[layer].push(id);
  }
  for (const values of layers) values.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] | null = null;
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidatePath = pathById.get(id)!;
    if (
      criticalPath === null ||
      finish > totalDuration ||
      (finish === totalDuration && comparePaths(candidatePath, criticalPath) < 0)
    ) {
      totalDuration = finish;
      criticalPath = candidatePath;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath: criticalPath ?? [] };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") throw new Error(`unknown command: ${args[0]}`);
  if (args.length < 2) throw new Error("missing input file\nusage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) throw new Error(`unknown argument or flag: ${args[2]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    throw new Error(`cannot read ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(createPlan(validate(input))));
}

main(Bun.argv.slice(2)).catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
