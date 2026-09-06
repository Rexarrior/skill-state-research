type RawTask = {
  id?: unknown;
  duration?: unknown;
  dependsOn?: unknown;
};

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

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index]!.localeCompare(right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("input must be a JSON object");
  }

  const tasksValue = (input as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksValue)) fail("tasks must be an array");

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${label} must be an object`);
    }

    const raw = value as RawTask;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependsOnValue = raw.dependsOn ?? [];
    if (!Array.isArray(dependsOnValue)) fail(`${label}.dependsOn must be an array`);
    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOnValue.length; dependencyIndex += 1) {
      const dependency = dependsOnValue[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      dependencies.add(dependency);
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

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | undefined {
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
  }

  for (const id of [...dependencies.keys()].sort()) {
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
  for (const values of dependents.values()) values.sort();

  let ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  const layers: string[][] = [];

  while (ready.length > 0) {
    const layer = ready;
    layers.push(layer);
    order.push(...layer);
    const next: string[] = [];
    for (const id of layer) {
      for (const dependent of dependents.get(id)!) {
        const count = remaining.get(dependent)! - 1;
        remaining.set(dependent, count);
        if (count === 0) next.push(dependent);
      }
    }
    ready = next.sort();
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const bestPath = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);

    const candidates: string[][] = [];
    if (start === 0) candidates.push([id]);
    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish === start) {
        candidates.push([...bestPath.get(dependency)!, id]);
      }
    }
    candidates.sort(compareSequences);
    bestPath.set(id, candidates[0]!);
  }

  const criticalPath = tasks.length === 0
    ? []
    : order
        .filter((id) => earliest[id]!.finish === totalDuration)
        .map((id) => bestPath.get(id)!)
        .sort(compareSequences)[0]!;

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan") {
    fail("usage: bun run src/cli.ts plan INPUT.json (no flags are supported)");
  }

  const path = args[1]!;
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(createPlan(validate(input))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
