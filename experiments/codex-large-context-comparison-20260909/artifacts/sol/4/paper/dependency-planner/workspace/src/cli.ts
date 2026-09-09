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

function compareSequences(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const comparison = a[index]!.localeCompare(b[index]!);
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

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) fail("tasks must be an array");

  const ids = new Set<string>();
  const tasks: Task[] = [];

  for (let index = 0; index < root.tasks.length; index++) {
    const raw = root.tasks[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(item.id)) fail(`duplicate task id: ${item.id}`);
    if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }
    if (item.dependsOn !== undefined && !Array.isArray(item.dependsOn)) {
      fail(`${label}.dependsOn must be an array`);
    }

    const dependencies = item.dependsOn === undefined ? [] : item.dependsOn;
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === item.id) fail(`task ${item.id} cannot depend on itself`);
      seenDependencies.add(dependency);
    }

    ids.add(item.id);
    tasks.push({ id: item.id, duration: item.duration, dependsOn: [...dependencies] as string[] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown id: ${dependency}`);
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    const dependencies = [...tasksById.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        const start = stack.indexOf(dependency);
        return [...stack.slice(start), dependency];
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...tasksById.keys()].sort((a, b) => a.localeCompare(b))) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function planTasks(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort((a, b) => a.localeCompare(b));

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    fail(`cycle detected: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPrefix: string[] = [];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      const candidatePath = pathById.get(dependency)!;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start && bestPrefix.length > 0 && compareSequences(candidatePath, bestPrefix) < 0)
      ) {
        start = dependencyFinish;
        bestPrefix = candidatePath;
      } else if (dependencyFinish === start && bestPrefix.length === 0) {
        bestPrefix = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    pathById.set(id, [...bestPrefix, id]);
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort((a, b) => a.localeCompare(b));

  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id]!.finish), 0);
  let criticalPath: string[] = [];
  for (const id of order) {
    if (earliest[id]!.finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") {
    if (args[0]!.startsWith("-")) fail(`unknown flag: ${args[0]}`);
    fail(`unknown command: ${args[0]}`);
  }
  if (args.length < 2) fail("missing input file; usage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) {
    const flag = args.slice(1).find((argument) => argument.startsWith("-"));
    fail(flag ? `unknown flag: ${flag}` : `unexpected argument: ${args[2]}`);
  }
  if (args[1]!.startsWith("-")) fail(`unknown flag: ${args[1]}`);

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
  console.log(JSON.stringify(planTasks(validateInput(input))));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
