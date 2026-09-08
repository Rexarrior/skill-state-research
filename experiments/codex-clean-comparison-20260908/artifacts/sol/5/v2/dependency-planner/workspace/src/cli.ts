type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Schedule = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

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

function fail(message: string): never {
  throw new Error(message);
}

export function parseTasks(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("input must be a JSON object");
  }

  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < root.tasks.length; index += 1) {
    const raw = root.tasks[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }

    const value = raw as Record<string, unknown>;
    if (typeof value.id !== "string" || value.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) fail(`duplicate task id: ${JSON.stringify(value.id)}`);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(rawDependencies)) fail(`${label}.dependsOn must be an array`);

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(value.id);
    tasks.push({ id: value.id, duration: value.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort(compareIds)]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (dependencyState === 1) {
        const start = positions.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return null;
  };

  for (const id of tasks.map((task) => task.id).sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

export function createSchedule(tasks: Task[]): Schedule {
  const cycle = findCycle(tasks);
  if (cycle !== null) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
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
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let predecessorPath: string[] | null = null;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      const dependencyPath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start &&
          predecessorPath !== null &&
          comparePaths(dependencyPath, predecessorPath) < 0)
      ) {
        start = dependencyFinish;
        predecessorPath = dependencyPath;
      } else if (dependencyFinish === start && predecessorPath === null) {
        predecessorPath = dependencyPath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...(predecessorPath ?? []), id]);
    totalDuration = Math.max(totalDuration, finish);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort(compareIds);

  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id]!.finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`unknown command: ${JSON.stringify(args[0])}`);
  if (args.length !== 2) {
    if (args.slice(1).some((argument) => argument.startsWith("-"))) {
      fail(`unknown flag: ${JSON.stringify(args.slice(1).find((argument) => argument.startsWith("-")))}`);
    }
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON: ${detail}`);
  }

  console.log(JSON.stringify(createSchedule(parseTasks(input))));
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

