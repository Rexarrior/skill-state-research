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

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and normalize the input document. */
export function parseTasks(input: unknown): Task[] {
  if (!isRecord(input)) fail("input must be a JSON object");
  if (!Array.isArray(input.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < input.tasks.length; index += 1) {
    const raw = input.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`${label} must be an object`);
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${JSON.stringify(raw.id)}`);
    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) fail(`${label}.dependsOn must be an array`);

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${JSON.stringify(dependency)}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    ids.add(raw.id);
    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`);
      }
    }
  }

  return tasks;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareIds(values[middle], value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function concreteCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackPosition = new Map<string, number>();

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stackPosition.set(id, stack.length);
    stack.push(id);

    const dependencies = [...byId.get(id)!.dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      if ((state.get(dependency) ?? 0) === 0) {
        const found = visit(dependency);
        if (found) return found;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(stackPosition.get(dependency)), dependency];
      }
    }

    stack.pop();
    stackPosition.delete(id);
    state.set(id, 2);
    return undefined;
  };

  for (const id of [...byId.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Build a deterministic dependency plan from already validated tasks. */
export function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();

  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort(compareIds);

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = concreteCycle(tasks);
    fail(`cycle detected: ${cycle?.join(" -> ") ?? "unknown cycle"}`);
  }

  const layers: string[][] = [];
  const layerById = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = {};

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
    const finish = start + task.duration;
    earliest[id] = { start, finish };

  }

  for (const layer of layers) layer.sort(compareIds);

  const totalDuration = order.length === 0
    ? 0
    : Math.max(...order.map((id) => earliest[id].finish));
  let criticalPath: string[] = [];
  if (order.length > 0) {
    // Mark nodes that can reach a total-duration endpoint by following only
    // edges on a longest path. Working over this subgraph makes the greedy
    // walk compare full sequences correctly, including prefix ties caused by
    // zero-duration tasks.
    const canReachEnd = new Set<string>();
    for (const id of [...order].reverse()) {
      if (
        earliest[id].finish === totalDuration ||
        dependents.get(id)!.some((dependent) =>
          canReachEnd.has(dependent) && earliest[dependent].start === earliest[id].finish
        )
      ) {
        canReachEnd.add(id);
      }
    }

    let current = tasks
      .filter((task) => task.dependsOn.length === 0 && canReachEnd.has(task.id))
      .map((task) => task.id)
      .sort(compareIds)[0];
    criticalPath.push(current);

    while (earliest[current].finish !== totalDuration) {
      current = dependents.get(current)!
        .filter((dependent) =>
          canReachEnd.has(dependent) && earliest[dependent].start === earliest[current].finish
        )
        .sort(compareIds)[0];
      criticalPath.push(current);
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

export function planDocument(input: unknown): Plan {
  return createPlan(parseTasks(input));
}

function usage(): string {
  return "Usage: bun run src/cli.ts plan INPUT.json";
}

export async function run(args: string[]): Promise<Plan> {
  if (args.length === 0) fail(`missing command\n${usage()}`);
  if (args[0].startsWith("-")) fail(`unknown flag: ${args[0]}\n${usage()}`);
  if (args[0] !== "plan") fail(`unknown command: ${args[0]}\n${usage()}`);
  if (args.length < 2) fail(`missing input file\n${usage()}`);
  if (args[1].startsWith("-")) fail(`unknown flag: ${args[1]}\n${usage()}`);
  if (args.length > 2) {
    const extra = args[2];
    fail(`${extra.startsWith("-") ? "unknown flag" : "unexpected argument"}: ${extra}\n${usage()}`);
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${JSON.stringify(args[1])}: ${detail}`);
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in ${JSON.stringify(args[1])}: ${detail}`);
  }
  return planDocument(document);
}

if (import.meta.main) {
  try {
    const result = await run(Bun.argv.slice(2));
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
