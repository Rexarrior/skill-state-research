type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): Task[] {
  if (!isRecord(value)) fail("input must be a JSON object");
  if (!Array.isArray(value.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const at = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`${at} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${at}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id "${raw.id}"`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${at}.duration must be a finite non-negative number`);
    }

    const dependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependencies)) fail(`${at}.dependsOn must be an array`);
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${at}.dependsOn contains duplicate id "${dependency}"`);
      }
      if (dependency === raw.id) fail(`task "${raw.id}" cannot depend on itself`);
      seenDependencies.add(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependencies] as string[] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(positions.get(dependency)!), dependency];
      }
    }

    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return null;
  };

  for (const id of [...dependencies.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle].localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function plan(tasks: Task[]) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
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
      if (count === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle detected: ${cycle!.join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const paths = new Map<string, string[]>();
  const layerById = new Map<string, number>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = taskById.get(id)!;
    let start = 0;
    let bestPrefix: string[] = [];
    let layer = 0;
    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidate = paths.get(dependency)!;
      if (finish > start || (finish === start && comparePaths(candidate, bestPrefix) < 0)) {
        start = finish;
        bestPrefix = candidate;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    earliest[id] = { start, finish: start + task.duration };
    paths.set(id, [...bestPrefix, id]);
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
  }
  for (const ids of layers) ids.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidate = paths.get(id)!;
    if (finish > totalDuration || (finish === totalDuration && comparePaths(candidate, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = candidate;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`unknown command "${args[0]}"`);
  if (args.length < 2) fail("missing input file; usage: bun run src/cli.ts plan INPUT.json");
  if (args.length > 2) fail(`unknown flag or argument "${args[2]}"`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read "${args[1]}": ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in "${args[1]}": ${detail}`);
  }

  console.log(JSON.stringify(plan(parseTasks(input))));
}

await main();
