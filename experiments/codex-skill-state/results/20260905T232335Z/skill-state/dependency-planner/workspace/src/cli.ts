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

class CliError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): Task[] {
  if (!isRecord(value)) {
    throw new CliError("Input must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) {
    throw new CliError('Field "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index += 1) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) {
      throw new CliError(`${label} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new CliError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new CliError(`Duplicate task id: ${raw.id}`);
    }
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      throw new CliError(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new CliError(`${label}.dependsOn must be an array of strings`);
    }
    const dependsOn: string[] = [];
    const dependencySet = new Set<string>();
    for (let depIndex = 0; depIndex < rawDependencies.length; depIndex += 1) {
      const dependency = rawDependencies[depIndex];
      if (typeof dependency !== "string") {
        throw new CliError(`${label}.dependsOn[${depIndex}] must be a string`);
      }
      if (dependencySet.has(dependency)) {
        throw new CliError(`Task ${raw.id} has duplicate dependency: ${dependency}`);
      }
      if (dependency === raw.id) {
        throw new CliError(`Task ${raw.id} cannot depend on itself`);
      }
      dependencySet.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new CliError(`Task ${task.id} depends on unknown task: ${dependency}`);
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
  for (let index = 0; index < length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);
    const dependencies = [...tasksById.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(positions.get(dependency)!), dependency];
      }
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

function makePlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remaining.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
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
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new CliError(`Dependency cycle: ${cycle!.join(" -> ")}`);
  }

  const timings = new Map<string, Timing>();
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    let predecessorPath: string[] = [];
    for (const dependency of task.dependsOn) {
      const finish = timings.get(dependency)!.finish;
      if (finish > start) {
        start = finish;
        predecessorPath = pathById.get(dependency)!;
      } else if (finish === start) {
        const candidate = pathById.get(dependency)!;
        if (predecessorPath.length === 0 || compareSequences(candidate, predecessorPath) < 0) {
          predecessorPath = candidate;
        }
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    timings.set(id, { start, finish: start + task.duration });
    layerById.set(id, layer);
    pathById.set(id, [...predecessorPath, id]);
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of [...tasksById.keys()].sort()) {
    const timing = timings.get(id)!;
    const path = pathById.get(id)!;
    if (
      timing.finish > totalDuration ||
      (timing.finish === totalDuration &&
        (criticalPath.length === 0 || compareSequences(path, criticalPath) < 0))
    ) {
      totalDuration = timing.finish;
      criticalPath = path;
    }
  }

  const earliest: Record<string, Timing> = {};
  for (const id of [...tasksById.keys()].sort()) earliest[id] = timings.get(id)!;
  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(args: string[]): never {
  if (args.length === 0) {
    throw new CliError("Missing command. Usage: dependency-planner plan INPUT.json");
  }
  if (args[0] !== "plan") {
    throw new CliError(`Unknown command: ${args[0]}`);
  }
  if (args.length < 2) {
    throw new CliError("Missing input file. Usage: dependency-planner plan INPUT.json");
  }
  throw new CliError(`Unknown argument or flag: ${args[2]}`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") usageError(args);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot read input file ${args[1]}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid JSON in ${args[1]}: ${detail}`);
  }
  console.log(JSON.stringify(makePlan(parseTasks(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
