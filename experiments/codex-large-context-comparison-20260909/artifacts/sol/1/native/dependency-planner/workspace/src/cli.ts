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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) {
    throw new PlannerError("input must be a JSON object");
  }
  if (!Array.isArray(input.tasks)) {
    throw new PlannerError('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const raw = input.tasks[index];
    const location = `tasks[${index}]`;
    if (!isRecord(raw)) {
      throw new PlannerError(`${location} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new PlannerError(`${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new PlannerError(`duplicate task id: ${JSON.stringify(raw.id)}`);
    }
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      throw new PlannerError(
        `${location}.duration must be a finite non-negative number`,
      );
    }
    if (raw.dependsOn !== undefined && !Array.isArray(raw.dependsOn)) {
      throw new PlannerError(`${location}.dependsOn must be an array`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOn.length; dependencyIndex += 1) {
      const dependency = dependsOn[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new PlannerError(
          `${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        throw new PlannerError(
          `${location}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
    }

    ids.add(raw.id);
    tasks.push({
      id: raw.id,
      duration: raw.duration,
      dependsOn: [...dependsOn],
    } as Task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new PlannerError(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new PlannerError(
          `task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`,
        );
      }
    }
    task.dependsOn.sort(compareIds);
  }

  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function canonicalizeCycle(cycle: string[]): string[] {
  const body = cycle.slice(0, -1);
  let best = body;
  for (let offset = 1; offset < body.length; offset += 1) {
    const rotated = body.slice(offset).concat(body.slice(0, offset));
    if (compareSequences(rotated, best) < 0) best = rotated;
  }
  return [...best, best[0]];
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    for (const dependency of tasksById.get(id)!.dependsOn) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        const start = stackPositions.get(dependency)!;
        return canonicalizeCycle([...stack.slice(start), dependency]);
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
  throw new Error("cycle expected but none found");
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareIds(values[middle], value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

export function validateAndPlan(input: unknown): Plan {
  const tasks = validate(input);
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
  for (const children of dependents.values()) children.sort(compareIds);

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
    throw new PlannerError(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliestById = new Map<string, { start: number; finish: number }>();
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let layer = 0;
    let start = 0;
    let bestPath: string[] | undefined;

    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliestById.get(dependency)!.finish;
      const candidatePath = [...pathById.get(dependency)!, id];
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          (bestPath === undefined || compareSequences(candidatePath, bestPath) < 0))
      ) {
        start = dependencyFinish;
        bestPath = candidatePath;
      }
    }

    const finish = start + task.duration;
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliestById.set(id, { start, finish });
    pathById.set(id, bestPath ?? [id]);
  }

  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  for (const timing of earliestById.values()) {
    totalDuration = Math.max(totalDuration, timing.finish);
  }

  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliestById.get(id)!.finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  for (const id of [...tasksById.keys()].sort(compareIds)) {
    // defineProperty also handles the otherwise-special object key "__proto__".
    Object.defineProperty(earliest, id, {
      value: earliestById.get(id)!,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usageError(message?: string): PlannerError {
  const usage = "Usage: bun run src/cli.ts plan INPUT.json";
  return new PlannerError(message ? `${message}\n${usage}` : usage);
}

export async function run(args: string[]): Promise<void> {
  const flag = args.find((argument) => argument.startsWith("-"));
  if (flag !== undefined) throw usageError(`unknown flag: ${flag}`);
  if (args.length === 0) throw usageError();
  if (args[0] !== "plan") throw usageError(`unknown command: ${args[0]}`);
  if (args.length !== 2) throw usageError("plan requires exactly one input file");

  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlannerError(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlannerError(`invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
  }

  console.log(JSON.stringify(validateAndPlan(input)));
}

if (import.meta.main) {
  try {
    await run(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
