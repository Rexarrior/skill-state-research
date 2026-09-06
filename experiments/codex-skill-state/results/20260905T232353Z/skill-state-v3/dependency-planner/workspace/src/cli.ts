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

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(a[index]!, b[index]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function fail(message: string): never {
  throw new Error(message);
}

export function validateInput(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.tasks)) fail("tasks must be an array");

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const at = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${at} must be an object`);
    }

    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      fail(`${at}.id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) fail(`duplicate task id: ${candidate.id}`);
    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      fail(`${at}.duration must be a finite non-negative number`);
    }

    const rawDependencies = candidate.dependsOn ?? [];
    if (!Array.isArray(rawDependencies)) fail(`${at}.dependsOn must be an array`);
    const dependencySet = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencySet.has(dependency)) {
        fail(`${at}.dependsOn contains duplicate id: ${dependency}`);
      }
      dependencySet.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(candidate.id);
    tasks.push({ id: candidate.id, duration: candidate.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} references unknown dependency: ${dependency}`);
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort(compareIds);
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

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const list of dependents.values()) list.sort(compareIds);

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

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const bestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    let selectedPath: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish !== start) continue;
      const candidate = [...bestPath.get(dependency)!, id];
      if (selectedPath === undefined || comparePaths(candidate, selectedPath) < 0) {
        selectedPath = candidate;
      }
    }
    bestPath.set(id, selectedPath!);
  }

  for (const layer of layers) layer.sort(compareIds);
  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliest[id]!.finish),
    0,
  );
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id]!.finish !== totalDuration) continue;
    const candidate = bestPath.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function plan(value: unknown): Plan {
  return createPlan(validateInput(value));
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    fail(`cannot read input file ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
