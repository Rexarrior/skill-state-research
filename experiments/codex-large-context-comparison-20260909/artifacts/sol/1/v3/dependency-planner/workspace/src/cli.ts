type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(value: unknown): Task[] {
  if (!isRecord(value)) fail("input must be a JSON object");
  if (!Array.isArray(value.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) fail(`${label}.dependsOn must be an array`);

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} references unknown dependency: ${dependency}`);
    }
  }

  return tasks;
}

function comparePaths(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index++) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findCycle(tasksById: Map<string, Task>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPosition = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackPosition.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stackPosition.get(dependency)!), dependency];
      }
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    stackPosition.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
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
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    fail(`dependency cycle: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    const layer = task.dependsOn.length === 0
      ? 0
      : Math.max(...task.dependsOn.map((dependency) => layerById.get(dependency)!)) + 1;
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    let start = 0;
    let path = [id];
    if (task.dependsOn.length > 0) {
      start = Math.max(...task.dependsOn.map((dependency) => earliest[dependency].finish));
      const candidates = task.dependsOn
        .filter((dependency) => earliest[dependency].finish === start)
        .map((dependency) => [...pathById.get(dependency)!, id]);
      candidates.sort(comparePaths);
      path = candidates[0];
    }
    earliest[id] = { start, finish: start + task.duration };
    pathById.set(id, path);
  }

  for (const layer of layers) layer.sort(compareIds);
  const totalDuration = order.length === 0
    ? 0
    : Math.max(...order.map((id) => earliest[id].finish));
  const criticalCandidates = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => pathById.get(id)!);
  criticalCandidates.sort(comparePaths);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalCandidates[0] ?? [],
  };
}

export async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(createPlan(validateInput(input))));
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
