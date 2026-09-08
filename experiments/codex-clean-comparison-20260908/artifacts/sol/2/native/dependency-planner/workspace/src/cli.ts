export interface TaskInput {
  id: string;
  duration: number;
  dependsOn?: string[];
}

export interface Schedule {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export class CycleError extends Error {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Dependency cycle: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSequences(left: string[], right: string[]): number {
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

export function validateInput(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InputError(`input must be an object, got ${describe(input)}`);
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError(`tasks must be an array, got ${describe(tasksValue)}`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const location = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new InputError(`${location} must be an object`);
    }

    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new InputError(`${location}.id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) {
      throw new InputError(`duplicate task id: ${JSON.stringify(candidate.id)}`);
    }
    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      throw new InputError(`${location}.duration must be a finite non-negative number`);
    }

    const dependencies = candidate.dependsOn ?? [];
    if (!Array.isArray(dependencies)) {
      throw new InputError(`${location}.dependsOn must be an array`);
    }
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(
          `${location}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
    }

    ids.add(candidate.id);
    tasks.push({
      id: candidate.id,
      duration: candidate.duration,
      dependsOn: [...dependencies] as string[],
    });
  }

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`tasks[${index}].dependsOn cannot contain its own id`);
      }
      if (!ids.has(dependency)) {
        throw new InputError(
          `tasks[${index}].dependsOn references unknown task ${JSON.stringify(dependency)}`,
        );
      }
    }
    task.dependsOn.sort(compareIds);
  }

  return tasks;
}

function normalizeCycle(cycle: string[]): string[] {
  const nodes = cycle.slice(0, -1);
  let best = nodes;
  for (let index = 1; index < nodes.length; index += 1) {
    const rotated = [...nodes.slice(index), ...nodes.slice(0, index)];
    if (compareSequences(rotated, best) < 0) best = rotated;
  }
  return [...best, best[0]!];
}

function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPositions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackPositions.set(id, stack.length);
    stack.push(id);

    for (const dependency of tasksById.get(id)!.dependsOn) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        const start = stackPositions.get(dependency)!;
        return normalizeCycle([...stack.slice(start), dependency]);
      }
    }

    stack.pop();
    stackPositions.delete(id);
    state.set(id, 2);
    return undefined;
  };

  const ids = [...tasksById.keys()].sort(compareIds);
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function createSchedule(input: unknown): Schedule {
  const tasks = validateInput(input);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasksById);
  if (cycle) throw new CycleError(cycle);

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
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  const earliestById = new Map<string, { start: number; finish: number }>();
  const layerById = new Map<string, number>();
  const criticalPathById = new Map<string, string[]>();
  let highestLayer = -1;

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliestById.get(dependency)!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new InputError(`schedule time exceeds the finite number range at task ${JSON.stringify(id)}`);
    }
    earliestById.set(id, { start, finish });
    layerById.set(id, layer);
    highestLayer = Math.max(highestLayer, layer);

    if (task.dependsOn.length === 0) {
      criticalPathById.set(id, [id]);
    } else {
      const candidates = task.dependsOn
        .filter((dependency) => earliestById.get(dependency)!.finish === start)
        .map((dependency) => [...criticalPathById.get(dependency)!, id]);
      candidates.sort(compareSequences);
      criticalPathById.set(id, candidates[0]!);
    }
  }

  const layers = Array.from({ length: highestLayer + 1 }, () => [] as string[]);
  for (const id of order) layers[layerById.get(id)!]!.push(id);
  for (const layer of layers) layer.sort(compareIds);

  const earliest: Record<string, { start: number; finish: number }> = {};
  const sortedIds = [...tasksById.keys()].sort(compareIds);
  for (const id of sortedIds) earliest[id] = earliestById.get(id)!;

  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliestById.get(id)!.finish),
    0,
  );
  const criticalCandidates = order
    .filter((id) => earliestById.get(id)!.finish === totalDuration)
    .map((id) => criticalPathById.get(id)!);
  criticalCandidates.sort(compareSequences);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalCandidates[0] ?? [],
  };
}

function usage(): string {
  return "Usage: bun run src/cli.ts plan INPUT.json";
}

export async function run(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error(usage());
    return 1;
  }
  if (args[0] !== "plan") {
    const kind = args[0]!.startsWith("-") ? "flag" : "command";
    console.error(`Unknown ${kind}: ${args[0]}`);
    console.error(usage());
    return 1;
  }
  const flag = args.slice(1).find((argument) => argument.startsWith("-"));
  if (flag !== undefined) {
    console.error(`Unknown flag: ${flag}`);
    console.error(usage());
    return 1;
  }
  if (args.length < 2) {
    console.error("Missing input file");
    console.error(usage());
    return 1;
  }
  if (args.length > 2) {
    console.error(`Unexpected argument: ${args[2]}`);
    console.error(usage());
    return 1;
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Cannot read input file ${JSON.stringify(args[1])}: ${detail}`);
    return 1;
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
    return 1;
  }

  try {
    console.log(JSON.stringify(createSchedule(input)));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}
