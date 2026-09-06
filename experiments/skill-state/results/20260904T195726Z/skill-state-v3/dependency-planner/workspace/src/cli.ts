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

function comparePaths(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const comparison = a[i]!.localeCompare(b[i]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

export function parseInput(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.tasks)) fail("tasks must be an array");

  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }

    const task = raw as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) fail(`duplicate task id: ${task.id}`);
    ids.add(task.id);

    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = task.dependsOn ?? [];
    if (!Array.isArray(rawDependencies)) fail(`${label}.dependsOn must be an array`);
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    tasks.push({ id: task.id, duration: task.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return tasks;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of dependencies.get(id)!) {
      if (state.get(dependency) === 1) {
        const start = stack.indexOf(dependency);
        return [...stack.slice(start), dependency];
      }
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...dependencies.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort();

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
    fail(`dependency cycle: ${findCycle(tasks).join(" -> ")}`);
  }

  const earliest: Plan["earliest"] = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let predecessorPath: string[] = [];
    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      if (
        dependencyFinish > start ||
        (dependencyFinish === start && comparePaths(pathById.get(dependency)!, predecessorPath) < 0)
      ) {
        start = dependencyFinish;
        predecessorPath = pathById.get(dependency)!;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...predecessorPath, id]);
    totalDuration = Math.max(totalDuration, finish);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  let criticalPath: string[] = [];
  for (const id of order) {
    const path = pathById.get(id)!;
    if (earliest[id]!.finish === totalDuration && (criticalPath.length === 0 || comparePaths(path, criticalPath) < 0)) {
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan") {
    fail("usage: bun run src/cli.ts plan INPUT.json (no flags are supported)");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    fail(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(parseInput(input))));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
