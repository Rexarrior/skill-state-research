export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface PlanOutput {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const comparison = compareIds(left[i]!, right[i]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareIds(values[middle]!, value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function validateInput(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError("tasks must be an array");
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const rawTask = tasksValue[index];
    if (typeof rawTask !== "object" || rawTask === null || Array.isArray(rawTask)) {
      throw new InputError(`tasks[${index}] must be an object`);
    }

    const raw = rawTask as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
      throw new InputError(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new InputError(`duplicate task id: ${raw.id}`);
    }
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      throw new InputError(`task ${raw.id}: duration must be a finite non-negative number`);
    }

    const dependsOnValue = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOnValue)) {
      throw new InputError(`task ${raw.id}: dependsOn must be an array`);
    }

    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOnValue.length; dependencyIndex += 1) {
      const dependency = dependsOnValue[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(
          `task ${raw.id}: dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (dependencies.has(dependency)) {
        throw new InputError(`task ${raw.id}: duplicate dependency: ${dependency}`);
      }
      if (dependency === raw.id) {
        throw new InputError(`task ${raw.id}: cannot depend on itself`);
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id}: unknown dependency: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();

  const ids = [...tasksById.keys()].sort(compareIds);
  for (const root of ids) {
    if ((state.get(root) ?? 0) !== 0) continue;

    const path: string[] = [root];
    const pathIndexes = new Map<string, number>([[root, 0]]);
    const frames = [
      {
        id: root,
        dependencies: [...tasksById.get(root)!.dependsOn].sort(compareIds),
        nextDependency: 0,
      },
    ];
    state.set(root, 1);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.nextDependency >= frame.dependencies.length) {
        frames.pop();
        path.pop();
        pathIndexes.delete(frame.id);
        state.set(frame.id, 2);
        continue;
      }

      const dependency = frame.dependencies[frame.nextDependency++]!;
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 1) {
        const start = pathIndexes.get(dependency)!;
        return [...path.slice(start), dependency];
      }
      if (dependencyState === 0) {
        state.set(dependency, 1);
        pathIndexes.set(dependency, path.length);
        path.push(dependency);
        frames.push({
          id: dependency,
          dependencies: [...tasksById.get(dependency)!.dependsOn].sort(compareIds),
          nextDependency: 0,
        });
      }
    }
  }
  return undefined;
}

export function plan(input: unknown): PlanOutput {
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
  for (const values of dependents.values()) {
    values.sort(compareIds);
  }

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
    throw new InputError(`cycle detected: ${cycle!.join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const earliestById = new Map<string, { start: number; finish: number }>();
  const criticalPathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;
    let bestDependencyPath: string[] | undefined;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliestById.get(dependency)!.finish;
      const dependencyPath = criticalPathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestDependencyPath === undefined ||
            compareSequences(dependencyPath, bestDependencyPath) < 0))
      ) {
        start = dependencyFinish;
        bestDependencyPath = dependencyPath;
      }
    }

    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliestById.set(id, { start, finish: start + task.duration });
    criticalPathById.set(id, [...(bestDependencyPath ?? []), id]);
  }

  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  for (const timing of earliestById.values()) {
    totalDuration = Math.max(totalDuration, timing.finish);
  }

  let criticalPath: string[] = [];
  if (tasks.length > 0) {
    const candidates = order
      .filter((id) => earliestById.get(id)!.finish === totalDuration)
      .map((id) => criticalPathById.get(id)!)
      .sort(compareSequences);
    criticalPath = candidates[0]!;
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  for (const id of [...tasksById.keys()].sort(compareIds)) {
    earliest[id] = earliestById.get(id)!;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(detail?: string): never {
  const prefix = detail ? `${detail}; ` : "";
  throw new InputError(`${prefix}usage: bun run src/cli.ts plan INPUT.json`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0) usageError();
  const unknownFlag = args.find((argument) => argument.startsWith("-"));
  if (unknownFlag) usageError(`unknown flag: ${unknownFlag}`);
  if (args[0] !== "plan") usageError(`unknown command: ${args[0]}`);
  if (args.length !== 2) usageError();
  if (args[1]!.startsWith("-")) usageError(`unknown flag: ${args[1]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read ${args[1]}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in ${args[1]}: ${detail}`);
  }

  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
