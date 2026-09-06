type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type InputTask = {
  id?: unknown;
  duration?: unknown;
  dependsOn?: unknown;
};

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function validate(input: unknown): Task[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("input must be an object with a tasks array");
  }
  const tasks = (input as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) fail("tasks must be an array");

  const ids = new Set<string>();
  const result: Task[] = tasks.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`tasks[${index}] must be an object`);
    }
    const task = raw as InputTask;
    if (typeof task.id !== "string" || task.id.length === 0) {
      fail(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(task.id)) fail(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      fail(`tasks[${index}].duration must be a finite non-negative number`);
    }
    const dependsOn = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      fail(`tasks[${index}].dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail(`tasks[${index}].dependsOn must contain unique ids`);
    }
    if (dependsOn.includes(task.id)) fail(`task ${task.id} cannot depend on itself`);
    return { id: task.id, duration: task.duration, dependsOn: [...dependsOn] };
  });

  for (const task of result) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return result;
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

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasks, byId);
  if (cycle) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  for (const ids of dependents.values()) ids.sort();

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

  const earliest: Record<string, { start: number; finish: number }> = {};
  const path = new Map<string, string[]>();
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let bestPath: string[] = [];
    let layer = 0;
    for (const dependency of task.dependsOn) {
      const candidate = earliest[dependency];
      if (candidate.finish > start) {
        start = candidate.finish;
        bestPath = path.get(dependency)!;
      } else if (candidate.finish === start) {
        const candidatePath = path.get(dependency)!;
        if (candidatePath.join("\u0000") < bestPath.join("\u0000")) bestPath = candidatePath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    earliest[id] = { start, finish: start + task.duration };
    path.set(id, [...bestPath, id]);
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const candidate = path.get(id)!;
    if (finish > totalDuration || (finish === totalDuration && candidate.join("\u0000") < criticalPath.join("\u0000"))) {
      totalDuration = finish;
      criticalPath = candidate;
    }
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (process.argv.length !== 4 || process.argv[2] !== "plan" || process.argv[3].startsWith("-")) {
  fail("usage: bun run src/cli.ts plan INPUT.json");
}

let input: unknown;
try {
  input = JSON.parse(await Bun.file(process.argv[3]).text());
} catch (error) {
  fail(`cannot read valid JSON from ${process.argv[3]}: ${(error as Error).message}`);
}
console.log(JSON.stringify(plan(validate(input))));
