type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

class InputError extends Error {}

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const comparison = a[i]!.localeCompare(b[i]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError("tasks must be an array");
  }

  const seenIds = new Set<string>();
  const tasks: Task[] = tasksValue.map((raw, index) => {
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new InputError(`${label} must be an object`);
    }

    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new InputError(`${label}.id must be a non-empty string`);
    }
    if (seenIds.has(item.id)) {
      throw new InputError(`duplicate task id: ${item.id}`);
    }
    seenIds.add(item.id);

    if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration < 0) {
      throw new InputError(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new InputError(`${label}.dependsOn must be an array of strings`);
    }
    const dependencyIds: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === item.id) {
        throw new InputError(`task ${item.id} cannot depend on itself`);
      }
      seenDependencies.add(dependency);
      dependencyIds.push(dependency);
    }

    return { id: item.id, duration: item.duration, dependsOn: dependencyIds };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!seenIds.has(dependency)) {
        throw new InputError(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stack.push(id);
    const dependencies = [...byId.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        const start = stack.lastIndexOf(dependency);
        return [...stack.slice(start), dependency];
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...byId.keys()].sort((a, b) => a.localeCompare(b))) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  throw new Error("cycle expected but not found");
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort((a, b) => a.localeCompare(b));

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        const insertionPoint = ready.findIndex((candidate) => candidate.localeCompare(dependent) > 0);
        if (insertionPoint === -1) ready.push(dependent);
        else ready.splice(insertionPoint, 0, dependent);
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new InputError(`dependency cycle: ${findCycle(tasks).join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const paths = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPath: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      const candidatePath = paths.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start && candidatePath.length > 0 &&
          (bestPath.length === 0 || comparePaths(candidatePath, bestPath) < 0))
      ) {
        start = dependencyFinish;
        bestPath = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    // Starting a new chain at this task can tie a zero-duration predecessor chain.
    const continuedPath = [...bestPath, id];
    const ownPath = [id];
    paths.set(id, start === 0 && comparePaths(ownPath, continuedPath) < 0 ? ownPath : continuedPath);
    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
  }

  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));
  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id]!.finish), 0);
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id]!.finish !== totalDuration) continue;
    const candidate = paths.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    throw new InputError("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    throw new InputError(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new InputError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(plan(parseTasks(input))));
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
