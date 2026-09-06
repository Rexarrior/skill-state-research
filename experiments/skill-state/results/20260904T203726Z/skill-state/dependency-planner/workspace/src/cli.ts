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
  console.error(message);
  process.exit(1);
}

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("Invalid input: expected an object with a tasks array.");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail("Invalid input: tasks must be an array.");

  const ids = new Set<string>();
  const tasks: Task[] = tasksValue.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`Invalid task at index ${index}: expected an object.`);
    }
    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`Invalid task at index ${index}: id must be a non-empty string.`);
    }
    if (ids.has(raw.id)) fail(`Invalid input: duplicate task id ${JSON.stringify(raw.id)}.`);
    ids.add(raw.id);

    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`Invalid task ${JSON.stringify(raw.id)}: duration must be a finite non-negative number.`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn) || !dependsOn.every((id) => typeof id === "string")) {
      fail(`Invalid task ${JSON.stringify(raw.id)}: dependsOn must be an array of strings.`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail(`Invalid task ${JSON.stringify(raw.id)}: dependsOn entries must be unique.`);
    }
    if (dependsOn.includes(raw.id)) {
      fail(`Invalid task ${JSON.stringify(raw.id)}: a task cannot depend on itself.`);
    }
    return { id: raw.id, duration: raw.duration, dependsOn };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`Invalid task ${JSON.stringify(task.id)}: unknown dependency ${JSON.stringify(dependency)}.`);
      }
    }
  }
  return tasks;
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] | undefined {
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of [...byId.get(id)!.dependsOn].sort()) {
      if (state.get(dependency) === 1) return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!state.has(task.id)) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
  }
}

function plan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasks, byId);
  if (cycle) fail(`Cycle detected: ${cycle.join(" -> ")}`);

  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!.sort()) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  const earliest: Plan["earliest"] = {};
  const paths = new Map<string, string[]>();
  const layers: string[][] = [];
  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let bestPath: string[] = [];
    for (const dependency of task.dependsOn) {
      const candidateFinish = earliest[dependency].finish;
      const candidatePath = paths.get(dependency)!;
      if (candidateFinish > start || (candidateFinish === start && (bestPath.length === 0 || candidatePath.join("\0") < bestPath.join("\0")))) {
        start = candidateFinish;
        bestPath = candidatePath;
      }
      layer = Math.max(layer, layers.findIndex((items) => items.includes(dependency)) + 1);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    paths.set(id, [...bestPath, id]);
    (layers[layer] ??= []).push(id);
    const path = paths.get(id)!;
    if (finish > totalDuration || (finish === totalDuration && path.join("\0") < criticalPath.join("\0"))) {
      totalDuration = finish;
      criticalPath = path;
    }
  }
  for (const layer of layers) layer.sort();
  return { order, layers, earliest, totalDuration, criticalPath };
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
  fail("Usage: bun run src/cli.ts plan INPUT.json");
}

let parsed: unknown;
try {
  parsed = JSON.parse(await Bun.file(args[1]).text());
} catch (error) {
  fail(`Unable to read valid JSON from ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(JSON.stringify(plan(validate(parsed))));
