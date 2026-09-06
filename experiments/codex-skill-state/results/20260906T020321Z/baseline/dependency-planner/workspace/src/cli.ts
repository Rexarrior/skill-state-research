type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(value: unknown): Task[] {
  if (!isRecord(value)) {
    fail("input must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) {
    fail('"tasks" must be an array');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index += 1) {
    const candidate = value.tasks[index];
    const label = `tasks[${index}]`;
    if (!isRecord(candidate)) {
      fail(`${label} must be an object`);
    }
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) {
      fail(`duplicate task id: ${JSON.stringify(candidate.id)}`);
    }
    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = candidate.dependsOn === undefined ? [] : candidate.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`${label}.dependsOn must be an array`);
    }
    const dependencies: string[] = [];
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
      dependencies.push(dependency);
    }

    ids.add(candidate.id);
    tasks.push({ id: candidate.id, duration: candidate.duration, dependsOn: dependencies });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        fail(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        fail(`task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
      }
    }
  }

  return tasks;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findCycle(tasksById: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const ids = [...tasksById.keys()].sort(compareIds);
  for (const root of ids) {
    if ((state.get(root) ?? 0) !== 0) continue;

    const path: string[] = [root];
    const pathIndex = new Map<string, number>([[root, 0]]);
    const stack = [{
      id: root,
      nextDependency: 0,
      dependencies: [...tasksById.get(root)!.dependsOn].sort(compareIds),
    }];
    state.set(root, 1);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.nextDependency >= frame.dependencies.length) {
        state.set(frame.id, 2);
        pathIndex.delete(frame.id);
        path.pop();
        stack.pop();
        continue;
      }

      const dependency = frame.dependencies[frame.nextDependency++];
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 1) {
        return [...path.slice(pathIndex.get(dependency)), dependency];
      }
      if (dependencyState === 0) {
        state.set(dependency, 1);
        pathIndex.set(dependency, path.length);
        path.push(dependency);
        stack.push({
          id: dependency,
          nextDependency: 0,
          dependencies: [...tasksById.get(dependency)!.dependsOn].sort(compareIds),
        });
      }
    }
  }
  return undefined;
}

export function createPlan(tasks: Task[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasksById);
  if (cycle) {
    fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const values of dependents.values()) {
    values.sort(compareIds);
  }

  const ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  // A null prototype keeps valid ids such as "__proto__" safe as object keys.
  const earliest = Object.create(null) as Record<string, { start: number; finish: number }>;
  const layerById = new Map<string, number>();
  const layers: string[][] = [];
  const criticalPathById = new Map<string, string[]>();

  for (const id of order) {
    const task = tasksById.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    (layers[layer] ??= []).push(id);

    if (task.dependsOn.length === 0) {
      criticalPathById.set(id, [id]);
    } else {
      const criticalDependencies = task.dependsOn
        .filter((dependency) => earliest[dependency].finish === start)
        .map((dependency) => criticalPathById.get(dependency)!)
        .sort(comparePaths);
      criticalPathById.set(id, [...criticalDependencies[0], id]);
    }
  }
  for (const layer of layers) {
    layer.sort(compareIds);
  }

  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id].finish), 0);
  const criticalPath = order.length === 0
    ? []
    : order
        .filter((id) => earliest[id].finish === totalDuration && dependents.get(id)!.length === 0)
        .map((id) => criticalPathById.get(id)!)
        .sort(comparePaths)[0];

  return { order, layers, earliest, totalDuration, criticalPath };
}

function usage(): string {
  return "Usage: bun run src/cli.ts plan INPUT.json";
}

export async function main(args: string[]): Promise<void> {
  if (args.length === 0) fail(usage());
  if (args[0].startsWith("-")) fail(`unknown flag: ${args[0]}\n${usage()}`);
  if (args[0] !== "plan") fail(`unknown command: ${args[0]}\n${usage()}`);
  if (args.length < 2) fail(`missing input file\n${usage()}`);
  if (args[1].startsWith("-")) fail(`unknown flag: ${args[1]}\n${usage()}`);
  if (args.length > 2) {
    const extra = args[2];
    fail(`${extra.startsWith("-") ? "unknown flag" : "unexpected argument"}: ${extra}\n${usage()}`);
  }

  const inputPath = args[1];
  let source: string;
  try {
    source = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${JSON.stringify(inputPath)}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in ${JSON.stringify(inputPath)}: ${detail}`);
  }

  const plan = createPlan(validateInput(input));
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
