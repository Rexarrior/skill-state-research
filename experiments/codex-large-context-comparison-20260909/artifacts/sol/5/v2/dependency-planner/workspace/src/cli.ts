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

const usage = "Usage: bun run src/cli.ts plan INPUT.json";

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input)) fail("input must be a JSON object");
  if (!Array.isArray(input.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    if (typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) fail(`${label}.dependsOn must be an array`);
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      if (dependency === raw.id) fail(`task ${raw.id} cannot depend on itself`);
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return tasks;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function findCycle(tasksById: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  function visit(id: string): string[] | undefined {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);
    const dependencies = [...tasksById.get(id)!.dependsOn].sort();
    for (const dependency of dependencies) {
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(positions.get(dependency)!), dependency];
      }
    }
    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return undefined;
  }

  for (const id of [...tasksById.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return [];
}

function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort();

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    let path = [id];
    if (task.dependsOn.length > 0) {
      const candidates = task.dependsOn
        .filter((dependency) => earliest[dependency].finish === start)
        .map((dependency) => [...pathById.get(dependency)!, id]);
      candidates.sort(comparePaths);
      path = candidates[0];
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, path);
    totalDuration = Math.max(totalDuration, finish);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const values of layers) values.sort();

  const finalPaths = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => pathById.get(id)!);
  finalPaths.sort(comparePaths);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: finalPaths[0] ?? [],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknownFlag = args.find((argument) => argument.startsWith("-"));
  if (unknownFlag) fail(`unknown flag: ${unknownFlag}\n${usage}`);
  if (args[0] !== "plan") {
    fail(`${args[0] === undefined ? "missing command" : `unknown command: ${args[0]}`}\n${usage}`);
  }
  if (args.length !== 2) fail(`plan requires exactly one input file\n${usage}`);

  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    fail(`invalid JSON in ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(validate(input))));
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
