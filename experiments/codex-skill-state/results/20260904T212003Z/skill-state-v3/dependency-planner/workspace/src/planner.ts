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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const comparison = compareIds(a[i]!, b[i]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

export function validateInput(input: unknown): Task[] {
  if (!isRecord(input) || !Array.isArray(input.tasks)) {
    throw new Error('input must be an object with a "tasks" array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) throw new Error(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) throw new Error(`${label}.dependsOn must be an array`);
    const dependencySet = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencySet.has(dependency)) {
        throw new Error(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === raw.id) throw new Error(`task ${raw.id} cannot depend on itself`);
      dependencySet.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort(compareIds)]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);
    for (const dependency of dependencies.get(id)!) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
    }
    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of tasks.map((task) => task.id).sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort(compareIds);

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new Error(`dependency cycle: ${findCycle(tasks).join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const bestPath = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    let prefix: string[] = [];
    const eligibleDependencies = task.dependsOn
      .filter((dependency) => earliest[dependency]!.finish === start)
      .map((dependency) => bestPath.get(dependency)!)
      .sort(comparePaths);
    if (eligibleDependencies.length > 0) prefix = eligibleDependencies[0]!;

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    bestPath.set(id, [...prefix, id]);
    (layers[layer] ??= []).push(id);
  }
  for (const currentLayer of layers) currentLayer.sort(compareIds);

  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id]!.finish), 0);
  const candidatePaths = order
    .filter((id) => earliest[id]!.finish === totalDuration)
    .map((id) => bestPath.get(id)!)
    .sort(comparePaths);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: candidatePaths[0] ?? [],
  };
}

export function planInput(input: unknown): Plan {
  return createPlan(validateInput(input));
}
