type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

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

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail('"tasks" must be an array');

  const ids = new Set<string>();
  const tasks: Task[] = tasksValue.map((raw, index) => {
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }

    const record = raw as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) fail(`duplicate task id: ${record.id}`);
    ids.add(record.id);

    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = record.dependsOn ?? [];
    if (!Array.isArray(dependencies)) fail(`${label}.dependsOn must be an array`);
    const seen = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seen.has(dependency)) fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      seen.add(dependency);
    }

    return { id: record.id, duration: record.duration, dependsOn: [...dependencies] as string[] };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown id: ${dependency}`);
    }
  }

  return tasks;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    const dependencies = [...byId.get(id)!.dependsOn].sort(compareIds);
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
  };

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort(compareIds);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
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
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;

    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency]!.finish;
      if (finish > start) start = finish;
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    let bestPath: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish !== start) continue;
      const candidate = [...pathById.get(dependency)!, id];
      if (bestPath === undefined || compareSequences(candidate, bestPath) < 0) {
        bestPath = candidate;
      }
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
    pathById.set(id, bestPath!);
  }

  for (const ids of layers) ids.sort(compareIds);
  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliest[id]!.finish),
    0,
  );
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id]!.finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    fail(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(createPlan(parseTasks(value))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
