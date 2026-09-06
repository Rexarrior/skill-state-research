type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function compareSequences(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function parseTasks(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail("tasks must be an array");

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let i = 0; i < tasksValue.length; i++) {
    const value = tasksValue[i];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`tasks[${i}] must be an object`);
    }

    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`tasks[${i}].id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`task ${raw.id} duration must be a finite non-negative number`);
    }

    const dependsOnValue = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOnValue)) fail(`task ${raw.id} dependsOn must be an array`);

    const dependsOn: string[] = [];
    const dependencies = new Set<string>();
    for (let j = 0; j < dependsOnValue.length; j++) {
      const dependency = dependsOnValue[j];
      if (typeof dependency !== "string") {
        fail(`task ${raw.id} dependsOn[${j}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        fail(`task ${raw.id} has duplicate dependency: ${dependency}`);
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} references unknown dependency: ${dependency}`);
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stack.indexOf(dependency)), dependency];
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

  for (const id of [...byId.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function buildPlan(tasks: Task[]) {
  const cycle = findCycle(tasks);
  if (cycle) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.id);
      dependents.set(dependency, list);
    }
  }

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, Timing> = {};
  const paths = new Map<string, string[]>();

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
    earliest[id] = { start, finish: start + task.duration };

    const criticalDependencies = task.dependsOn
      .filter((dependency) => earliest[dependency].finish === start)
      .map((dependency) => paths.get(dependency)!)
      .sort(compareSequences);
    paths.set(id, criticalDependencies.length === 0 ? [id] : [...criticalDependencies[0], id]);
  }

  for (const layer of layers) layer.sort();
  const totalDuration = order.length === 0
    ? 0
    : Math.max(...order.map((id) => earliest[id].finish));
  const criticalPath = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => paths.get(id)!)
    .sort(compareSequences)[0] ?? [];

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
    fail(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(JSON.stringify(buildPlan(parseTasks(input))));
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
