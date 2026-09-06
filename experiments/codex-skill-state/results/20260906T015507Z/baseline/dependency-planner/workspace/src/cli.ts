type InputTask = {
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

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateInput(value: unknown): InputTask[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlannerError("input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new PlannerError(`tasks must be an array (received ${describe(tasksValue)})`);
  }

  const tasks: InputTask[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const valueAtIndex = tasksValue[index];
    const location = `tasks[${index}]`;

    if (typeof valueAtIndex !== "object" || valueAtIndex === null || Array.isArray(valueAtIndex)) {
      throw new PlannerError(`${location} must be an object`);
    }

    const candidate = valueAtIndex as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new PlannerError(`${location}.id must be a non-empty string`);
    }
    if (seenIds.has(candidate.id)) {
      throw new PlannerError(`duplicate task id: ${candidate.id}`);
    }
    seenIds.add(candidate.id);

    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      throw new PlannerError(`${location}.duration must be a finite non-negative number`);
    }

    const dependencies = candidate.dependsOn === undefined ? [] : candidate.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new PlannerError(`${location}.dependsOn must be an array of strings`);
    }

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new PlannerError(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new PlannerError(`duplicate dependency ${dependency} in task ${candidate.id}`);
      }
      if (dependency === candidate.id) {
        throw new PlannerError(`task ${candidate.id} cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: candidate.id, duration: candidate.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!seenIds.has(dependency)) {
        throw new PlannerError(`task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  return tasks;
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

function findCycle(tasksById: Map<string, InputTask>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }

  throw new PlannerError("cycle detected");
}

export function createPlan(input: unknown): Plan {
  const tasks = validateInput(input);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const taskDependents of dependents.values()) taskDependents.sort(compareIds);

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
    throw new PlannerError(`cycle detected: ${findCycle(tasksById).join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, { start: number; finish: number }> = {};
  const bestPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      start = Math.max(start, earliest[dependency]!.finish);
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new PlannerError(`schedule time overflow while planning task ${id}`);
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    Object.defineProperty(earliest, id, {
      value: { start, finish },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const pathCandidates: string[][] = [];
    if (task.dependsOn.length === 0) {
      pathCandidates.push([id]);
    } else {
      for (const dependency of task.dependsOn) {
        if (earliest[dependency]!.finish === start) {
          pathCandidates.push([...bestPathById.get(dependency)!, id]);
        }
      }
    }
    pathCandidates.sort(comparePaths);
    bestPathById.set(id, pathCandidates[0]!);
  }

  for (const layer of layers) layer.sort(compareIds);

  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliest[id]!.finish),
    0,
  );
  const criticalCandidates = order
    .filter((id) => earliest[id]!.finish === totalDuration)
    .map((id) => bestPathById.get(id)!);
  criticalCandidates.sort(comparePaths);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalCandidates[0] ?? [],
  };
}

function usageError(message: string): PlannerError {
  return new PlannerError(`${message}\nUsage: bun run src/cli.ts plan INPUT.json`);
}

export async function runCli(args: string[]): Promise<void> {
  if (args.length === 0) throw usageError("missing command");
  if (args[0] !== "plan") throw usageError(`unknown command: ${args[0]}`);
  if (args.length < 2) throw usageError("missing input file");
  if (args[1]!.startsWith("-")) throw usageError(`unknown flag: ${args[1]}`);
  if (args.length > 2) throw usageError(`unknown argument or flag: ${args[2]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlannerError(`cannot read input file ${args[1]}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlannerError(`invalid JSON in ${args[1]}: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  try {
    await runCli(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
