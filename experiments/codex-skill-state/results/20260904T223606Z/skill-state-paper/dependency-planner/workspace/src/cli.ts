type TaskInput = {
  id: string;
  duration: number;
  dependsOn?: string[];
};

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

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("Input must be an object with a tasks array.");
  }
  const tasksValue = (input as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksValue)) fail("tasks must be an array.");

  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < tasksValue.length; index++) {
    const value = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${label} must be an object.`);
    }
    const raw = value as Partial<TaskInput>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string.`);
    }
    if (ids.has(raw.id)) fail(`Duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number.`);
    }
    let dependsOn: string[];
    if (raw.dependsOn === undefined) {
      dependsOn = [];
    } else {
      if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((id) => typeof id !== "string")) {
        fail(`${label}.dependsOn must be an array of strings.`);
      }
      dependsOn = raw.dependsOn;
      if (new Set(dependsOn).size !== dependsOn.length) {
        fail(`${label}.dependsOn must not contain duplicates.`);
      }
      if (dependsOn.includes(raw.id)) fail(`${label}.dependsOn cannot contain its own id.`);
    }
    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`Task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return tasks;
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const position = new Map<string, number>();
  for (const id of byId.keys()) state.set(id, 0);

  function visit(id: string): string[] | null {
    state.set(id, 1);
    position.set(id, stack.length);
    stack.push(id);
    for (const dependency of [...byId.get(id)!.dependsOn].sort()) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(position.get(dependency)!), dependency];
      }
      if (state.get(dependency) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    position.delete(id);
    state.set(id, 2);
    return null;
  }

  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (state.get(task.id) === 0) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function plan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasks, byId);
  if (cycle) fail(`Cycle detected: ${cycle.join(" -> ")}`);

  const dependents = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    pending.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const list of dependents.values()) list.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of dependents.get(id)!) {
      const remaining = pending.get(child)! - 1;
      pending.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  const earliest: Plan["earliest"] = {};
  const layers: string[][] = [];
  const bestPath: Record<string, string[]> = {};
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let predecessor: string | undefined;
    for (const dependency of task.dependsOn) {
      const candidate = earliest[dependency].finish;
      const dependencyLayer = layers.findIndex((entries) => entries.includes(dependency));
      layer = Math.max(layer, dependencyLayer + 1);
      if (candidate > start || (candidate === start && (predecessor === undefined || comparePaths(bestPath[dependency], bestPath[predecessor]) < 0))) {
        start = candidate;
        predecessor = dependency;
      }
    }
    while (layers.length <= layer) layers.push([]);
    layers[layer].push(id);
    earliest[id] = { start, finish: start + task.duration };
    bestPath[id] = predecessor === undefined ? [id] : [...bestPath[predecessor], id];
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    if (finish > totalDuration || (finish === totalDuration && comparePaths(bestPath[id], criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = bestPath[id];
    }
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

function comparePaths(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "plan") {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(args[1]).text());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read valid JSON from ${args[1]}: ${detail}`);
  }
  console.log(JSON.stringify(plan(validate(parsed))));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
