type RawTask = {
  id: string;
  duration: number;
  dependsOn: string[];
};

export type Plan = {
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

export function validateInput(value: unknown): RawTask[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Invalid input: expected a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.tasks)) {
    fail('Invalid input: "tasks" must be an array');
  }

  const tasks: RawTask[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const value = input.tasks[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`Invalid input: ${label} must be an object`);
    }

    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      fail(`Invalid input: ${label}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) {
      fail(`Invalid input: duplicate task id "${task.id}"`);
    }
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      fail(`Invalid input: ${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`Invalid input: ${label}.dependsOn must be an array`);
    }
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`Invalid input: ${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`Invalid input: ${label}.dependsOn contains duplicate "${dependency}"`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(task.id);
    tasks.push({ id: task.id, duration: task.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        fail(`Invalid input: task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        fail(`Invalid input: task "${task.id}" references unknown dependency "${dependency}"`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: RawTask[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, number>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(positions.get(dependency)!), dependency];
      }
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...dependencies.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

export function createPlan(tasks: RawTask[]): Plan {
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
    fail(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const bestDuration = new Map<string, number>();
  const bestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    const start = task.dependsOn.reduce((maximum, dependency) => Math.max(maximum, earliest[dependency]!.finish), 0);
    earliest[id] = { start, finish: start + task.duration };

    const layer = task.dependsOn.reduce((maximum, dependency) => Math.max(maximum, layerById.get(dependency)! + 1), 0);
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    let duration = task.duration;
    let path = [id];
    for (const dependency of task.dependsOn) {
      const candidateDuration = bestDuration.get(dependency)! + task.duration;
      const candidatePath = [...bestPath.get(dependency)!, id];
      if (candidateDuration > duration || (candidateDuration === duration && comparePaths(candidatePath, path) < 0)) {
        duration = candidateDuration;
        path = candidatePath;
      }
    }
    bestDuration.set(id, duration);
    bestPath.set(id, path);
  }

  for (const layer of layers) layer.sort();
  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id]!.finish), 0);
  let criticalPath: string[] = [];
  for (const id of order) {
    if (bestDuration.get(id) !== totalDuration) continue;
    const candidate = bestPath.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function plan(value: unknown): Plan {
  return createPlan(validateInput(value));
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[0] !== "plan") fail(`Unknown command: ${args[0]}`);

  const unknownFlag = args.slice(1).find((argument) => argument.startsWith("-"));
  if (unknownFlag) fail(`Unknown flag: ${unknownFlag}`);
  if (args.length !== 2) fail("Usage: bun run src/cli.ts plan INPUT.json");

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    fail(`Cannot read input file "${args[1]}": ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
