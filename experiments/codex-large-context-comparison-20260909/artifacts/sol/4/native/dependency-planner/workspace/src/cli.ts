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

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerError";
  }
}

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function comparePaths(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareIds(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function validateInput(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PlannerError(`input must be an object (received ${describe(input)})`);
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new PlannerError(`"tasks" must be an array (received ${describe(tasksValue)})`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PlannerError(`${label} must be an object`);
    }

    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new PlannerError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new PlannerError(`duplicate task id "${raw.id}"`);
    }
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new PlannerError(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new PlannerError(`${label}.dependsOn must be an array`);
    }

    const seenDependencies = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new PlannerError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new PlannerError(`${label}.dependsOn contains duplicate id "${dependency}"`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new PlannerError(`task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new PlannerError(`task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  };

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
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
  const tasks = validateInput(input);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
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
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new PlannerError(`dependency cycle: ${cycle!.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const criticalPathTo = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    let path: string[] = [id];

    if (task.dependsOn.length > 0) {
      start = Math.max(...task.dependsOn.map((dependency) => earliest[dependency]!.finish));
      layer = Math.max(...task.dependsOn.map((dependency) => layerById.get(dependency)!)) + 1;

      const pathCandidates = task.dependsOn
        .filter((dependency) => earliest[dependency]!.finish === start)
        .map((dependency) => [...criticalPathTo.get(dependency)!, id]);
      pathCandidates.sort(comparePaths);
      path = pathCandidates[0]!;
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new PlannerError(`schedule time overflow while planning task "${id}"`);
    }
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    criticalPathTo.set(id, path);
  }

  for (const values of layers) values.sort(compareIds);
  const totalDuration = order.length === 0
    ? 0
    : Math.max(...order.map((id) => earliest[id]!.finish));
  const criticalPath = order.length === 0
    ? []
    : order
        .filter((id) => earliest[id]!.finish === totalDuration)
        .map((id) => criticalPathTo.get(id)!)
        .sort(comparePaths)[0]!;

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(message: string): PlannerError {
  return new PlannerError(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) throw usageError("missing command");
  if (args[0] !== "plan") {
    throw usageError(args[0]!.startsWith("-")
      ? `unknown flag "${args[0]}"`
      : `unknown command "${args[0]}"`);
  }
  if (args.length < 2) throw usageError("missing input file");
  if (args[1]!.startsWith("-")) throw usageError(`unknown flag "${args[1]}"`);
  if (args.length > 2) {
    const extra = args[2]!;
    throw usageError(extra.startsWith("-") ? `unknown flag "${extra}"` : `unexpected argument "${extra}"`);
  }

  const inputPath = args[1]!;
  let source: string;
  try {
    source = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlannerError(`cannot read input file "${inputPath}": ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlannerError(`invalid JSON in "${inputPath}": ${detail}`);
  }

  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
