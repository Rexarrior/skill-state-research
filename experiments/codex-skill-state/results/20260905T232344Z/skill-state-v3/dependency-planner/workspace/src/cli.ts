type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIds(a[index]!, b[index]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) throw new Error("Input must be a JSON object");
  if (!Array.isArray(input.tasks)) throw new Error('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const value = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${value.id}`);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(rawDependencies)) throw new Error(`${label}.dependsOn must be an array`);
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependency === value.id) throw new Error(`Task ${value.id} cannot depend on itself`);
      if (seenDependencies.has(dependency)) {
        throw new Error(`Task ${value.id} has duplicate dependency: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(value.id);
    tasks.push({ id: value.id, duration: value.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return tasks;
}

function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | undefined;

  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    const dependencies = [...tasks.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if (cycle) return;
      if ((state.get(dependency) ?? 0) === 0) {
        visit(dependency);
      } else if (state.get(dependency) === 1) {
        cycle = [...stack.slice(stack.indexOf(dependency)), dependency];
        return;
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of [...tasks.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) visit(id);
    if (cycle) return cycle;
  }
  throw new Error("Cycle detected");
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareIds(values[middle]!, value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

export function createPlan(input: unknown): Plan {
  const taskList = validate(input);
  const tasks = new Map(taskList.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of taskList) {
    indegree.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of taskList) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort(compareIds);

  const ready = taskList.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== taskList.length) {
    throw new Error(`Cycle detected: ${findCycle(tasks).join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const paths = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];

  for (const id of order) {
    const task = tasks.get(id)!;
    let start = 0;
    let layer = 0;
    let bestDependency: string | undefined;
    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      if (
        bestDependency === undefined ||
        dependencyFinish > start ||
        (dependencyFinish === start && comparePaths(paths.get(dependency)!, paths.get(bestDependency)!) < 0)
      ) {
        start = dependencyFinish;
        bestDependency = dependency;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    const path = bestDependency === undefined ? [id] : [...paths.get(bestDependency)!, id];
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    paths.set(id, path);

    if (finish > totalDuration || (finish === totalDuration && (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort(compareIds);

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error("Usage: bun run src/cli.ts plan INPUT.json");
  if (args[0]!.startsWith("-")) throw new Error(`Unknown flag: ${args[0]}`);
  if (args[0] !== "plan") throw new Error(`Unknown command: ${args[0]}`);
  if (args.length < 2) throw new Error("Missing input file\nUsage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) {
    const extra = args[2]!;
    throw new Error(extra.startsWith("-") ? `Unknown flag: ${extra}` : `Unexpected argument: ${extra}`);
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read input file ${args[1]}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${args[1]}: ${detail}`);
  }
  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
