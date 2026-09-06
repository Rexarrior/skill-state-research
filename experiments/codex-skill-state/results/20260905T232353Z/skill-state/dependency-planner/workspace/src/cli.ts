type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Schedule = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
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

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) {
    fail('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < root.tasks.length; index += 1) {
    const raw = root.tasks[index];
    const at = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${at} must be an object`);
    }

    const task = raw as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      fail(`${at}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) {
      fail(`duplicate task id: ${task.id}`);
    }
    if (
      typeof task.duration !== "number" ||
      !Number.isFinite(task.duration) ||
      task.duration < 0
    ) {
      fail(`${at}.duration must be a finite non-negative number`);
    }

    const rawDependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`${at}.dependsOn must be an array`);
    }

    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        fail(`${at}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === task.id) {
        fail(`task ${task.id} cannot depend on itself`);
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(task.id);
    tasks.push({ id: task.id, duration: task.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const position = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    position.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(position.get(dependency)!), dependency];
      }
    }

    stack.pop();
    position.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const id of [...dependencies.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

function plan(tasks: Task[]): Schedule {
  const cycle = findCycle(tasks);
  if (cycle !== null) {
    fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remainingDependencies = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const ids of dependents.values()) ids.sort();

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const earliest: Record<string, { start: number; finish: number }> = {};
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    const layer = task.dependsOn.length === 0
      ? 0
      : Math.max(...task.dependsOn.map((dependency) => layerById.get(dependency)!)) + 1;
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    const start = task.dependsOn.length === 0
      ? 0
      : Math.max(...task.dependsOn.map((dependency) => earliest[dependency].finish));
    const finish = start + task.duration;
    earliest[id] = { start, finish };

    const criticalDependencies = task.dependsOn
      .filter((dependency) => earliest[dependency].finish === start)
      .map((dependency) => pathById.get(dependency)!);
    const prefix = criticalDependencies.length === 0
      ? []
      : criticalDependencies.reduce((best, candidate) =>
          comparePaths(candidate, best) < 0 ? candidate : best
        );
    pathById.set(id, [...prefix, id]);
  }

  for (const layer of layers) layer.sort();
  const totalDuration = order.length === 0
    ? 0
    : Math.max(...order.map((id) => earliest[id].finish));
  const candidates = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => pathById.get(id)!);
  const criticalPath = candidates.length === 0
    ? []
    : candidates.reduce((best, candidate) =>
        comparePaths(candidate, best) < 0 ? candidate : best
      );

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${args[1]}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON: ${detail}`);
  }

  console.log(JSON.stringify(plan(parseTasks(input))));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
