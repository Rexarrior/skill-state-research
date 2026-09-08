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
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

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
    if (ids.has(item.id)) fail(`duplicate task id: ${JSON.stringify(item.id)}`);
    ids.add(item.id);

    if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(rawDependencies)) fail(`${label}.dependsOn must be an array`);
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let depIndex = 0; depIndex < rawDependencies.length; depIndex++) {
      const dependency = rawDependencies[depIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${depIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }
    tasks.push({ id: item.id, duration: item.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} depends on unknown id ${JSON.stringify(dependency)}`);
      }
    }
  }
  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const count = Math.min(left.length, right.length);
  for (let i = 0; i < count; i++) {
    const comparison = left[i].localeCompare(right[i]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, number>();
  const stack: string[] = [];
  const position = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    position.set(id, stack.length);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(position.get(dependency)), dependency];
      }
    }
    stack.pop();
    position.delete(id);
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

function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const list of dependents.values()) list.sort();

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
    fail(`dependency cycle detected: ${findCycle(tasks).join(" -> ")}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerOf = new Map<string, number>();
  const layers: string[][] = [];
  const bestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let prefix: string[] = [];
    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const candidate = bestPath.get(dependency)!;
      if (finish > start || (finish === start && compareSequences(candidate, prefix) < 0)) {
        start = finish;
        prefix = candidate;
      }
      layer = Math.max(layer, layerOf.get(dependency)! + 1);
    }
    earliest[id] = { start, finish: start + task.duration };
    layerOf.set(id, layer);
    (layers[layer] ??= []).push(id);
    bestPath.set(id, [...prefix, id]);
  }
  for (const ids of layers) ids.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidate = bestPath.get(id)!;
    if (finish > totalDuration || (finish === totalDuration && compareSequences(candidate, criticalPath) < 0)) {
      totalDuration = finish;
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
    fail(`cannot read ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(parseTasks(input))));
}

await main();
