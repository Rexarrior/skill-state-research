export interface InputTask {
  id: string;
  duration: number;
  dependsOn?: string[];
}

export interface Plan {
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

export class PlannerError extends Error {}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new PlannerError('Invalid input: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isObject(raw)) {
      throw new PlannerError(`Invalid input: ${label} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new PlannerError(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      throw new PlannerError(`Invalid input: duplicate task id "${raw.id}"`);
    }
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new PlannerError(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }
    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new PlannerError(`Invalid input: ${label}.dependsOn must be an array of strings`);
    }
    const seenDependencies = new Set<string>();
    const dependsOn: string[] = [];
    for (let depIndex = 0; depIndex < dependencies.length; depIndex++) {
      const dependency = dependencies[depIndex];
      if (typeof dependency !== "string") {
        throw new PlannerError(`Invalid input: ${label}.dependsOn[${depIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new PlannerError(`Invalid input: ${label}.dependsOn contains duplicate "${dependency}"`);
      }
      if (dependency === raw.id) {
        throw new PlannerError(`Invalid input: task "${raw.id}" cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }
    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new PlannerError(`Invalid input: task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
    task.dependsOn.sort(compareIds);
  }
  return tasks;
}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const comparison = compareIds(a[i], b[i]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function canonicalizeCycle(cycle: string[]): string[] {
  const nodes = cycle.slice(0, -1);
  let best = nodes;
  for (let i = 1; i < nodes.length; i++) {
    const candidate = [...nodes.slice(i), ...nodes.slice(0, i)];
    if (comparePaths(candidate, best) < 0) best = candidate;
  }
  return [...best, best[0]];
}

function findCycle(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndexes = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackIndexes.set(id, stack.length);
    stack.push(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      if ((state.get(dependency) ?? 0) === 0) {
        const found = visit(dependency);
        if (found) return found;
      } else if (state.get(dependency) === 1) {
        return canonicalizeCycle([...stack.slice(stackIndexes.get(dependency)!), dependency]);
      }
    }
    stack.pop();
    stackIndexes.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  throw new PlannerError("Dependency cycle detected");
}

export function createPlan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort(compareIds);

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }
  if (order.length !== tasks.length) {
    throw new PlannerError(`Dependency cycle detected: ${findCycle(tasks).join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPath: string[] = [];
    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidatePath = pathById.get(dependency)!;
      if (finish > start || (finish === start && (bestPath.length === 0 || comparePaths(candidatePath, bestPath) < 0))) {
        start = finish;
        bestPath = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...bestPath, id]);
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = pathById.get(id)!;
    if (finish > totalDuration || (finish === totalDuration && (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0))) {
      totalDuration = finish;
      criticalPath = path;
    }
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan") {
    throw new PlannerError(
      args[0] === "plan"
        ? "Usage: bun run src/cli.ts plan INPUT.json (no additional flags or arguments)"
        : `Unknown command${args[0] ? ` "${args[0]}"` : ""}. Usage: bun run src/cli.ts plan INPUT.json`,
    );
  }
  const inputPath = args[1];
  let source: string;
  try {
    source = await Bun.file(inputPath).text();
  } catch (error) {
    throw new PlannerError(`Cannot read "${inputPath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new PlannerError(`Invalid JSON in "${inputPath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
