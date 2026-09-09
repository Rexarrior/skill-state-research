type RawTask = {
  id: string;
  duration: number;
  dependsOn?: string[];
};

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

function fail(message: string): never {
  throw new Error(message);
}

function validate(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Invalid input: root must be an object");
  }

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) {
    fail("Invalid input: tasks must be an array");
  }

  const seen = new Set<string>();
  const tasks: Task[] = root.tasks.map((value, index) => {
    const at = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`Invalid input: ${at} must be an object`);
    }
    const raw = value as Partial<RawTask>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid input: ${at}.id must be a non-empty string`);
    }
    if (seen.has(raw.id)) {
      fail(`Invalid input: duplicate task id ${JSON.stringify(raw.id)}`);
    }
    seen.add(raw.id);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`Invalid input: ${at}.duration must be a finite non-negative number`);
    }
    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) {
      fail(`Invalid input: ${at}.dependsOn must be an array`);
    }
    const dependencySet = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid input: ${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencySet.has(dependency)) {
        fail(`Invalid input: ${at}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`);
      }
      dependencySet.add(dependency);
    }
    return { id: raw.id, duration: raw.duration, dependsOn: [...dependencies] as string[] };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        fail(`Invalid input: task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!seen.has(dependency)) {
        fail(`Invalid input: task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
      }
    }
  }
  return tasks;
}

function compareSequences(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const comparison = a[i].localeCompare(b[i]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function findCycle(tasks: Task[]): string[] | undefined {
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
  return undefined;
}

function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`Dependency cycle: ${cycle?.join(" -> ") ?? "detected"}`);
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, { start: number; finish: number }> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    const layer = task.dependsOn.length === 0
      ? 0
      : 1 + Math.max(...task.dependsOn.map((dependency) => layerById.get(dependency)!));
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    let start = 0;
    let bestPrefix: string[] = [];
    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidate = pathById.get(dependency)!;
      if (finish > start || (finish === start && compareSequences(candidate, bestPrefix) < 0)) {
        start = finish;
        bestPrefix = candidate;
      }
    }
    earliest[id] = { start, finish: start + task.duration };
    pathById.set(id, [...bestPrefix, id]);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (let index = 0; index < order.length; index++) {
    const id = order[index];
    const finish = earliest[id].finish;
    const candidate = pathById.get(id)!;
    if (index === 0 || finish > totalDuration || (finish === totalDuration && compareSequences(candidate, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) fail("Usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`Unknown command: ${args[0]}`);
  if (args.length !== 2) {
    const extra = args.find((arg, index) => index > 0 && arg.startsWith("-"));
    if (extra) fail(`Unknown flag: ${extra}`);
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[1].startsWith("-")) fail(`Unknown flag: ${args[1]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`Cannot read ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(validate(input))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
