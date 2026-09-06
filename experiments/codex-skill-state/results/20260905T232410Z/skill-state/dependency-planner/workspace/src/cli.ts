type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

class InputError extends Error {}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseTasks(value: unknown): Task[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(`input must be an object (received ${describe(value)})`);
  }

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) {
    throw new InputError(`tasks must be an array (received ${describe(root.tasks)})`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < root.tasks.length; index++) {
    const raw = root.tasks[index];
    const label = `tasks[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InputError(`${label} must be an object`);
    }

    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new InputError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) {
      throw new InputError(`duplicate task id: ${JSON.stringify(candidate.id)}`);
    }
    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      throw new InputError(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = candidate.dependsOn === undefined ? [] : candidate.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      throw new InputError(`${label}.dependsOn must be an array of unique strings`);
    }

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(
          `${label}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`,
        );
      }
      if (dependency === candidate.id) {
        throw new InputError(`${label} cannot depend on itself (${JSON.stringify(candidate.id)})`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(candidate.id);
    tasks.push({ id: candidate.id, duration: candidate.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new InputError(
          `task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort((a, b) => a.localeCompare(b))]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPosition = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackPosition.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackPosition.get(dependency)), dependency];
      }
    }

    stack.pop();
    stackPosition.delete(id);
    state.set(id, 2);
    return null;
  }

  const ids = tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  throw new Error("cycle expected but not found");
}

function buildPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)?.push(task.id);
    }
  }
  for (const ids of dependents.values()) ids.sort((a, b) => a.localeCompare(b));

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (remainingDependencies.get(dependent) as number) - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new InputError(`dependency cycle: ${findCycle(tasks).join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const criticalPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id) as Task;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, (layerById.get(dependency) as number) + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    const criticalDependencies = task.dependsOn.filter(
      (dependency) => earliest[dependency].finish === start,
    );
    if (criticalDependencies.length === 0) {
      criticalPathById.set(id, [id]);
    } else {
      let bestPath = [
        ...(criticalPathById.get(criticalDependencies[0]) as string[]),
        id,
      ];
      for (const dependency of criticalDependencies.slice(1)) {
        const candidate = [...(criticalPathById.get(dependency) as string[]), id];
        if (compareSequences(candidate, bestPath) < 0) bestPath = candidate;
      }
      criticalPathById.set(id, bestPath);
    }
  }

  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliest[id].finish),
    0,
  );
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = criticalPathById.get(id) as string[];
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usage(): string {
  return "usage: bun run src/cli.ts plan INPUT.json";
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    throw new InputError(`${usage()}\nunknown command or flags`);
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
  }

  console.log(JSON.stringify(buildPlan(parseTasks(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
