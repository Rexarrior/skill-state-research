type InputTask = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): InputTask[] {
  if (!isRecord(value)) fail("input must be a JSON object");
  if (!Array.isArray(value.tasks)) fail('"tasks" must be an array');

  const tasks: InputTask[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const at = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`${at} must be an object`);

    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${at}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${JSON.stringify(raw.id)}`);
    ids.add(raw.id);

    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      fail(`${at}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) fail(`${at}.dependsOn must be an array`);

    const dependencies: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${at}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
      }
      if (dependency === raw.id) fail(`task ${JSON.stringify(raw.id)} cannot depend on itself`);
      seenDependencies.add(dependency);
      dependencies.push(dependency);
    }

    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`);
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

function findCycle(tasks: InputTask[]): string[] {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort((a, b) => a.localeCompare(b))]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        const start = stackIndex.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...dependencies.keys()].sort((a, b) => a.localeCompare(b))) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function makePlan(tasks: InputTask[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
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
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPredecessorPath: string[] | undefined;

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency].finish;
      if (dependencyFinish > start) {
        start = dependencyFinish;
        bestPredecessorPath = pathById.get(dependency)!;
      } else if (dependencyFinish === start) {
        const candidate = pathById.get(dependency)!;
        if (!bestPredecessorPath || compareSequences(candidate, bestPredecessorPath) < 0) {
          bestPredecessorPath = candidate;
        }
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, [...(bestPredecessorPath ?? []), id]);
    (layers[layer] ??= []).push(id);
  }

  for (const values of layers) values.sort((a, b) => a.localeCompare(b));

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) totalDuration = Math.max(totalDuration, earliest[id].finish);
  for (const id of order) {
    if (earliest[id].finish !== totalDuration) continue;
    const candidate = pathById.get(id)!;
    if (criticalPath.length === 0 || compareSequences(candidate, criticalPath) < 0) {
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON: ${detail}`);
  }

  const plan = makePlan(parseTasks(input));
  console.log(JSON.stringify(plan));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
