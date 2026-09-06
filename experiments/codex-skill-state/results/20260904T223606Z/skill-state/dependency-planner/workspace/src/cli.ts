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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTasks(value: unknown): Task[] {
  if (!isPlainObject(value) || !Array.isArray(value.tasks)) {
    fail("Invalid input: 'tasks' must be an array.");
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const prefix = `Invalid task at index ${index}:`;
    if (!isPlainObject(raw)) fail(`${prefix} must be an object.`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${prefix} 'id' must be a non-empty string.`);
    }
    if (ids.has(raw.id)) fail(`Invalid input: duplicate task id '${raw.id}'.`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${prefix} 'duration' must be a finite non-negative number.`);
    }

    const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      fail(`${prefix} 'dependsOn' must be an array of strings.`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail(`${prefix} 'dependsOn' must not contain duplicates.`);
    }
    if (dependsOn.includes(raw.id)) fail(`${prefix} cannot depend on itself.`);

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn: [...dependsOn] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`Invalid task '${task.id}': unknown dependency '${dependency}'.`);
      }
    }
  }
  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of [...byId.get(id)!.dependsOn].sort()) {
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

  for (const id of [...byId.keys()].sort()) {
    if (!state.get(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function makePlan(tasks: Task[]): Plan {
  const cycle = findCycle(tasks);
  if (cycle) fail(`Dependency cycle detected: ${cycle.join(" -> ")}`);

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

  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  const layers: string[][] = [];
  const taskLayer = new Map<string, number>();
  const paths = new Map<string, string[]>();
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let path = [id];
    for (const dependency of task.dependsOn) {
      const dependencyTime = earliest[dependency].finish;
      const candidatePath = [...paths.get(dependency)!, id];
      if (dependencyTime > start || (dependencyTime === start && compareSequences(candidatePath, path) < 0)) {
        start = dependencyTime;
        path = candidatePath;
      }
      layer = Math.max(layer, taskLayer.get(dependency)! + 1);
    }
    earliest[id] = { start, finish: start + task.duration };
    taskLayer.set(id, layer);
    paths.set(id, path);
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] | undefined;
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = paths.get(id)!;
    if (criticalPath === undefined || finish > totalDuration || (finish === totalDuration && compareSequences(path, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = path;
    }
  }
  return { order, layers, earliest, totalDuration, criticalPath: criticalPath ?? [] };
}

export async function main(
  arguments_: string[],
  readFile: (path: string) => string | Promise<string> = (path) => Bun.file(path).text(),
): Promise<void> {
  if (arguments_.length !== 2 || arguments_[0] !== "plan" || arguments_[1].startsWith("-")) {
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(arguments_[1]));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Could not read valid JSON from '${arguments_[1]}': ${detail}`);
  }
  console.log(JSON.stringify(makePlan(parseTasks(input))));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
