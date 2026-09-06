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

function parseTasks(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const value = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${label} must be an object`);
    }

    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn)) fail(`${label}.dependsOn must be an array`);

    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOn.length; dependencyIndex++) {
      const dependency = dependsOn[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }

  return tasks;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
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
    return null;
  }

  for (const id of [...byId.keys()].sort(compareIds)) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function createPlan(tasks: Task[]): Plan {
  const cycle = findCycle(tasks);
  if (cycle) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }

  let ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!.sort(compareIds)) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const bestPathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    const start = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, earliest[dependency].finish),
      0,
    );
    const finish = start + task.duration;
    earliest[id] = { start, finish };

    const layer = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, layerById.get(dependency)! + 1),
      0,
    );
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    const eligiblePaths = task.dependsOn
      .filter((dependency) => earliest[dependency].finish === start)
      .map((dependency) => bestPathById.get(dependency)!);
    eligiblePaths.sort(comparePaths);
    bestPathById.set(id, eligiblePaths.length === 0 ? [id] : [...eligiblePaths[0], id]);
  }

  for (const layer of layers) layer.sort(compareIds);

  const totalDuration = order.reduce(
    (maximum, id) => Math.max(maximum, earliest[id].finish),
    0,
  );
  const criticalPaths = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => bestPathById.get(id)!);
  criticalPaths.sort(comparePaths);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalPaths[0] ?? [],
  };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.some((argument) => argument.startsWith("-"))) {
    fail(`unknown flag: ${args.find((argument) => argument.startsWith("-"))}`);
  }
  if (args[0] !== "plan") fail(`unknown command: ${args[0] ?? "(missing)"}`);
  if (args.length < 2) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) fail(`unexpected argument: ${args[2]}`);

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

  console.log(JSON.stringify(createPlan(parseTasks(input))));
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
