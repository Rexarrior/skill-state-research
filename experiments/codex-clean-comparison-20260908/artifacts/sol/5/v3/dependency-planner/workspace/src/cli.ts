type InputTask = {
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

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): InputTask[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    fail('Invalid schema: "tasks" must be an array');
  }

  const tasks: InputTask[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const raw = input.tasks[index];
    const location = `tasks[${index}]`;
    if (!isObject(raw)) {
      fail(`Invalid schema: ${location} must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid schema: ${location}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) {
      fail(`Invalid schema: duplicate task id "${raw.id}"`);
    }
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      fail(`Invalid schema: ${location}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`Invalid schema: ${location}.dependsOn must be an array of strings`);
    }
    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(
          `Invalid schema: ${location}.dependsOn[${dependencyIndex}] must be a string`,
        );
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid schema: ${location}.dependsOn contains duplicate "${dependency}"`);
      }
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        fail(`Invalid schema: task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        fail(`Invalid schema: task "${task.id}" references unknown id "${dependency}"`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: InputTask[]): string[] | null {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort(compareIds)]),
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

  for (const id of [...dependencies.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

function compareSequences(left: string[], right: string[]): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function createPlan(tasks: InputTask[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)?.push(task.id);
    }
  }
  for (const ids of dependents.values()) ids.sort(compareIds);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (remainingDependencies.get(dependent) as number) - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`Dependency cycle: ${(cycle ?? []).join(" -> ")}`);
  }

  const earliestById = new Map<string, Timing>();
  const layerById = new Map<string, number>();
  const bestPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id) as InputTask;
    let start = 0;
    let layer = 0;
    let predecessorPath: string[] = [];
    let hasPredecessor = false;

    for (const dependency of task.dependsOn) {
      const dependencyTiming = earliestById.get(dependency) as Timing;
      layer = Math.max(layer, (layerById.get(dependency) as number) + 1);
      const candidatePath = bestPathById.get(dependency) as string[];
      if (
        dependencyTiming.finish > start ||
        (dependencyTiming.finish === start &&
          (!hasPredecessor || compareSequences(candidatePath, predecessorPath) < 0))
      ) {
        start = dependencyTiming.finish;
        predecessorPath = candidatePath;
        hasPredecessor = true;
      }
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      fail(`Schedule time overflow while planning task "${id}"`);
    }
    earliestById.set(id, { start, finish });
    layerById.set(id, layer);
    bestPathById.set(id, [...predecessorPath, id]);
  }

  const layers: string[][] = [];
  for (const id of [...byId.keys()].sort(compareIds)) {
    const layer = layerById.get(id) as number;
    (layers[layer] ??= []).push(id);
  }

  const earliest: Record<string, Timing> = {};
  for (const id of [...byId.keys()].sort(compareIds)) {
    earliest[id] = earliestById.get(id) as Timing;
  }

  let totalDuration = 0;
  let criticalPath: string[] = [];
  let hasCriticalPath = false;
  for (const id of [...byId.keys()].sort(compareIds)) {
    const finish = (earliestById.get(id) as Timing).finish;
    const path = bestPathById.get(id) as string[];
    if (
      finish > totalDuration ||
      (finish === totalDuration &&
        (!hasCriticalPath || compareSequences(path, criticalPath) < 0))
    ) {
      totalDuration = finish;
      criticalPath = path;
      hasCriticalPath = true;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    if (args.some((argument) => argument.startsWith("-"))) {
      fail(`Unknown flag. Usage: bun run src/cli.ts plan INPUT.json`);
    }
    fail(`Unknown or missing command. Usage: bun run src/cli.ts plan INPUT.json`);
  }

  const path = args[1];
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read input file "${path}": ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON in "${path}": ${detail}`);
  }

  console.log(JSON.stringify(createPlan(validate(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
