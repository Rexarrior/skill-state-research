export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
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
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Validate and normalize the contents of an input file. */
export function parseTasks(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`input must be an object (received ${describe(input)})`);
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new Error("input.tasks must be an array");
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const location = `input.tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${location} must be an object`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      throw new Error(`duplicate task id ${JSON.stringify(record.id)}`);
    }
    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    const dependencies = record.dependsOn === undefined ? [] : record.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new Error(`${location}.dependsOn must be an array`);
    }

    const seenDependencies = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(
          `${location}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(record.id);
    tasks.push({ id: record.id, duration: record.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

function canonicalizeCycle(cycle: string[]): string[] {
  const nodes = cycle.slice(0, -1);
  let best = nodes;
  for (let index = 1; index < nodes.length; index += 1) {
    const rotated = [...nodes.slice(index), ...nodes.slice(0, index)];
    if (comparePaths(rotated, best) < 0) best = rotated;
  }
  return [...best, best[0]!];
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return canonicalizeCycle([
          ...stack.slice(stackPositions.get(dependency)!),
          dependency,
        ]);
      }
    }

    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  throw new Error("cycle detected");
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

/** Produce a deterministic schedule for validated tasks. */
export function createPlan(tasks: Task[]): Plan {
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
    throw new Error(`dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const timings = new Map<string, { start: number; finish: number }>();
  const layerById = new Map<string, number>();
  const criticalPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, timings.get(dependency)!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new Error(`schedule time overflow while planning task ${JSON.stringify(id)}`);
    }
    timings.set(id, { start, finish });
    layerById.set(id, layer);

    const criticalCandidates = task.dependsOn
      .filter((dependency) => timings.get(dependency)!.finish === start)
      .map((dependency) => [...criticalPathById.get(dependency)!, id]);
    // A path may start at any task. The singleton path ties with paths through
    // predecessors precisely when the earliest start is zero.
    if (start === 0) criticalCandidates.push([id]);
    criticalCandidates.sort(comparePaths);
    criticalPathById.set(id, criticalCandidates[0]!);
  }

  const layers: string[][] = [];
  for (const id of [...tasksById.keys()].sort(compareIds)) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  for (const id of [...tasksById.keys()].sort(compareIds)) {
    earliest[id] = timings.get(id)!;
  }

  const totalDuration = tasks.length === 0
    ? 0
    : Math.max(...timings.values().map(({ finish }) => finish));
  const criticalPath = tasks.length === 0
    ? []
    : order
        .filter((id) => timings.get(id)!.finish === totalDuration)
        .map((id) => criticalPathById.get(id)!)
        .sort(comparePaths)[0]!;

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function planInput(input: unknown): Plan {
  return createPlan(parseTasks(input));
}

async function runCli(args: string[]): Promise<void> {
  const command = args[0];
  if (command === undefined) {
    throw new Error("missing command; usage: dependency-planner plan INPUT.json");
  }
  if (command !== "plan") {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected "plan"`);
  }
  const inputPath = args[1];
  if (inputPath === undefined) {
    throw new Error("missing input file; usage: dependency-planner plan INPUT.json");
  }
  if (inputPath.startsWith("-")) {
    throw new Error(`unknown flag ${JSON.stringify(inputPath)}`);
  }
  if (args.length > 2) {
    const argument = args[2]!;
    if (argument.startsWith("-")) throw new Error(`unknown flag ${JSON.stringify(argument)}`);
    throw new Error(`unexpected argument ${JSON.stringify(argument)}`);
  }

  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${JSON.stringify(inputPath)}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(inputPath)}: ${detail}`);
  }

  console.log(JSON.stringify(planInput(input)));
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
