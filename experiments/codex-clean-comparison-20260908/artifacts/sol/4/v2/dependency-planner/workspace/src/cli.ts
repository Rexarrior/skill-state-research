export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

class InputError extends Error {}

function compareSequences(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const comparison = a[i].localeCompare(b[i]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function validate(value: unknown): Task[] {
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
    ids.add(record.id);

    if (typeof record.duration !== "number" || !Number.isFinite(record.duration) || record.duration < 0) {
      throw new InputError(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = record.dependsOn === undefined ? [] : record.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new InputError(`${label}.dependsOn must be an array`);
    }
    const seenDependencies = new Set<string>();
    const dependsOn: string[] = [];
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

    tasks.push({ id: record.id, duration: record.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`task ${task.id} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new InputError(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | undefined {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id)!) {
      if (!state.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackIndex.get(dependency)), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...dependencies.keys()].sort()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

export function createPlan(value: unknown): Plan {
  const tasks = validate(value);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
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
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    throw new InputError(`dependency cycle: ${cycle!.join(" -> ")}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = {};
  const criticalEndingAt = new Map<string, string[]>();

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

    const criticalPredecessors = task.dependsOn
      .filter((dependency) => earliest[dependency].finish === start)
      .map((dependency) => criticalEndingAt.get(dependency)!)
      .sort(compareSequences);
    criticalEndingAt.set(id, criticalPredecessors.length === 0 ? [id] : [...criticalPredecessors[0], id]);
  }

  for (const layer of layers) layer.sort();
  const totalDuration = order.length === 0 ? 0 : Math.max(...order.map((id) => earliest[id].finish));
  const criticalPath = order.length === 0
    ? []
    : order
      .filter((id) => earliest[id].finish === totalDuration)
      .map((id) => criticalEndingAt.get(id)!)
      .sort(compareSequences)[0];

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.some((argument) => argument.startsWith("-"))) {
    throw new InputError(`unknown flag: ${args.find((argument) => argument.startsWith("-"))}`);
  }
  if (args[0] !== "plan") {
    throw new InputError(args[0] ? `unknown command: ${args[0]}` : "missing command; usage: plan INPUT.json");
  }
  if (args.length !== 2) {
    throw new InputError("usage: plan INPUT.json");
  }

  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    throw new InputError(`cannot read ${args[1]}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new InputError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(value)));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
