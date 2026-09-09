export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface Schedule {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const comparison = a[i]!.localeCompare(b[i]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

export function validateInput(value: unknown): Task[] {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new Error('schema error: "tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) throw new Error(`schema error: ${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`schema error: ${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new Error(`schema error: duplicate task id "${raw.id}"`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`schema error: task "${raw.id}" duration must be a finite non-negative number`);
    }

    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new Error(`schema error: task "${raw.id}" dependsOn must be an array`);
    }
    const seenDependencies = new Set<string>();
    for (const dependency of dependencies) {
      if (typeof dependency !== "string") {
        throw new Error(`schema error: task "${raw.id}" dependencies must be strings`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(`schema error: task "${raw.id}" has duplicate dependency "${dependency}"`);
      }
      if (dependency === raw.id) {
        throw new Error(`schema error: task "${raw.id}" cannot depend on itself`);
      }
      seenDependencies.add(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependencies] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`schema error: task "${task.id}" references unknown dependency "${dependency}"`);
      }
    }
  }
  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, number>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);
    for (const dependency of dependencies.get(id)!) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return stack.slice(positions.get(dependency)!).concat(dependency);
      }
    }
    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...dependencies.keys()].sort()) {
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
    const middle = (low + high) >>> 1;
    if (values[middle]!.localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

export function createSchedule(tasks: Task[]): Schedule {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const list of dependents.values()) list.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
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
    throw new Error(`cycle detected: ${findCycle(tasks).join(" -> ")}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, { start: number; finish: number }> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let layer = 0;
    let start = 0;
    let bestPrefix: string[] | undefined;
    for (const dependency of task.dependsOn) {
      layer = Math.max(layer, layerById.get(dependency)! + 1);
      const dependencyFinish = earliest[dependency]!.finish;
      const dependencyPath = pathById.get(dependency)!;
      if (
        bestPrefix === undefined ||
        dependencyFinish > start ||
        (dependencyFinish === start && comparePaths(dependencyPath, bestPrefix) < 0)
      ) {
        start = dependencyFinish;
        bestPrefix = dependencyPath;
      }
    }
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    earliest[id] = { start, finish: start + task.duration };
    pathById.set(id, [...(bestPrefix ?? []), id]);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] | undefined;
  for (const id of order) {
    const finish = earliest[id]!.finish;
    const path = pathById.get(id)!;
    if (
      criticalPath === undefined ||
      finish > totalDuration ||
      (finish === totalDuration && comparePaths(path, criticalPath) < 0)
    ) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath: criticalPath ?? [] };
}
