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
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("Input must be an object with a tasks array.");
  }
  const tasksValue = (input as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksValue)) fail("tasks must be an array.");

  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const prefix = `tasks[${index}]`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${prefix} must be an object.`);
    }
    const task = value as Partial<TaskInput>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      fail(`${prefix}.id must be a non-empty string.`);
    }
    if (ids.has(task.id)) fail(`Task id '${task.id}' is duplicated.`);
    if (typeof task.duration !== "number" || !Number.isFinite(task.duration) || task.duration < 0) {
      fail(`${prefix}.duration must be a finite non-negative number.`);
    }
    const dependsOn = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      fail(`${prefix}.dependsOn must be an array of strings.`);
    }
    const uniqueDependencies = new Set(dependsOn);
    if (uniqueDependencies.size !== dependsOn.length) {
      fail(`${prefix}.dependsOn must not contain duplicates.`);
    }
    ids.add(task.id);
    tasks.push({ id: task.id, duration: task.duration, dependsOn: [...dependsOn] });
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`Task '${task.id}' cannot depend on itself.`);
      if (!ids.has(dependency)) fail(`Task '${task.id}' depends on unknown task '${dependency}'.`);
    }
  }
  return tasks;
}

function findCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    const dependencies = [...byId.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        return [...stack.slice(stack.indexOf(dependency)), dependency];
      }
      if (state.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (state.get(task.id) === undefined) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const cycle = findCycle(tasks);
  if (cycle) fail(`Cycle detected: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
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
    for (const dependent of dependents.get(id)!) {
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
    let predecessorPath: string[] = [];
    for (const dependency of task.dependsOn) {
      const candidateFinish = earliest[dependency].finish;
      start = Math.max(start, candidateFinish);
      layer = Math.max(layer, (layers.findIndex((tasksInLayer) => tasksInLayer.includes(dependency))) + 1);
      if (candidateFinish > (predecessorPath.length === 0 ? -1 : earliest[predecessorPath.at(-1)!].finish) ||
          (candidateFinish === (predecessorPath.length === 0 ? -1 : earliest[predecessorPath.at(-1)!].finish) &&
           paths.get(dependency)!.join("\u0000") < predecessorPath.join("\u0000"))) {
        predecessorPath = paths.get(dependency)!;
      }
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    const path = [...predecessorPath, id];
    paths.set(id, path);
    while (layers.length <= layer) layers.push([]);
    layers[layer].push(id);
    if (finish > totalDuration || (finish === totalDuration && path.join("\u0000") < criticalPath.join("\u0000"))) {
      totalDuration = finish;
      criticalPath = path;
    }
  }
  for (const layer of layers) layer.sort();
  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch {
    fail(`Cannot read input file '${args[1]}'.`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    fail("Invalid JSON input.");
  }
  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
