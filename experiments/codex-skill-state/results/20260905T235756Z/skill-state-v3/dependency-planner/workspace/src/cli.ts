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

export function validateInput(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail('"tasks" must be an array');

  const ids = new Set<string>();
  const tasks = tasksValue.map((raw, index): Task => {
    const at = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${at} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      fail(`${at}.id must be a non-empty string`);
    }
    if (ids.has(item.id)) fail(`duplicate task id: ${JSON.stringify(item.id)}`);
    ids.add(item.id);

    if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration < 0) {
      fail(`${at}.duration must be a finite non-negative number`);
    }
    const dependencies = item.dependsOn ?? [];
    if (!Array.isArray(dependencies)) fail(`${at}.dependsOn must be an array`);
    const seen = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seen.has(dependency)) {
        fail(`${at}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`);
      }
      seen.add(dependency);
      if (dependency === item.id) fail(`task ${JSON.stringify(item.id)} cannot depend on itself`);
    }
    return { id: item.id, duration: item.duration, dependsOn: [...dependencies] as string[] };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} depends on unknown id ${JSON.stringify(dependency)}`);
      }
    }
  }
  return tasks;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const position = new Map<string, number>();

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    position.set(id, stack.length);
    stack.push(id);
    for (const dependency of dependencies.get(id)!) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        return [...stack.slice(position.get(dependency)!), dependency];
      }
    }
    stack.pop();
    position.delete(id);
    state.set(id, 2);
    return null;
  };

  for (const id of [...dependencies.keys()].sort()) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function createPlan(tasks: Task[]): Plan {
  const cycle = findCycle(tasks);
  if (cycle) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort();

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
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();
  const layers: string[][] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    const start = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, earliest[dependency].finish),
      0,
    );
    earliest[id] = { start, finish: start + task.duration };

    const layer = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, layerById.get(dependency)! + 1),
      0,
    );
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    const eligible = task.dependsOn
      .filter((dependency) => earliest[dependency].finish === start)
      .map((dependency) => pathById.get(dependency)!)
      .sort(compareSequences);
    pathById.set(id, eligible.length === 0 ? [id] : [...eligible[0], id]);
  }
  for (const layer of layers) layer.sort();

  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id].finish), 0);
  const criticalCandidates = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => pathById.get(id)!)
    .sort(compareSequences);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalCandidates[0] ?? [],
  };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") fail(`unknown command: ${JSON.stringify(args[0])}`);
  if (args.length !== 2) {
    const detail = args.slice(2).find((arg) => arg.startsWith("-"));
    if (detail) fail(`unknown flag: ${detail}`);
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[1].startsWith("-")) fail(`unknown flag: ${args[1]}`);

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    fail(`cannot read ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(createPlan(validateInput(input))));
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
