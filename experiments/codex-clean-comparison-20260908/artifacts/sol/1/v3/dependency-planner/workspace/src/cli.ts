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

class InputError extends Error {}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = left[index]!.localeCompare(right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const raw = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new InputError(`${label} must be an object`);
    }

    const record = raw as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new InputError(`${label}.id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      throw new InputError(`duplicate task id: ${record.id}`);
    }
    if (
      typeof record.duration !== "number" ||
      !Number.isFinite(record.duration) ||
      record.duration < 0
    ) {
      throw new InputError(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = record.dependsOn ?? [];
    if (!Array.isArray(dependencies)) {
      throw new InputError(`${label}.dependsOn must be an array`);
    }

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(record.id);
    tasks.push({ id: record.id, duration: record.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`task ${task.id} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id} references unknown dependency: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasksById: Map<string, Task>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    const dependencies = [...tasksById.get(id)!.dependsOn].sort((a, b) => a.localeCompare(b));
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(stackIndex.get(dependency)!), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  };

  const ids = [...tasksById.keys()].sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]!.localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) values.sort((a, b) => a.localeCompare(b));

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
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
    throw new InputError(`dependency cycle detected: ${cycle!.join(" -> ")}`);
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    const candidates: string[][] = [];
    if (start === 0) candidates.push([id]);
    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish === start) {
        candidates.push([...pathById.get(dependency)!, id]);
      }
    }
    candidates.sort(compareSequences);
    pathById.set(id, candidates[0]!);
  }

  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  const totalDuration = tasks.length === 0
    ? 0
    : Math.max(...Object.values(earliest).map(({ finish }) => finish));
  const criticalCandidates = order
    .filter((id) => earliest[id]!.finish === totalDuration)
    .map((id) => pathById.get(id)!);
  criticalCandidates.sort(compareSequences);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalCandidates[0] ?? [],
  };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan") {
    if (args[0]?.startsWith("-") || args.slice(1).some((arg) => arg.startsWith("-"))) {
      fail(`unknown flag; Usage: bun run src/cli.ts plan INPUT.json`);
    }
    if (args[0] && args[0] !== "plan") {
      fail(`unknown command: ${args[0]}`);
    }
    fail("Usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    fail(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    console.log(JSON.stringify(createPlan(parseTasks(input))));
  } catch (error) {
    if (error instanceof InputError) fail(error.message);
    throw error;
  }
}

await main();
