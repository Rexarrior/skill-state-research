type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): Task[] {
  if (!isRecord(value)) fail("input must be a JSON object");
  if (!Array.isArray(value.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < value.tasks.length; index++) {
    const raw = value.tasks[index];
    const where = `tasks[${index}]`;
    if (!isRecord(raw)) fail(`${where} must be an object`);

    if (typeof raw.id !== "string" || raw.id.length === 0) {
      fail(`${where}.id must be a non-empty string`);
    }
    if (ids.has(raw.id)) fail(`duplicate task id: ${raw.id}`);
    ids.add(raw.id);

    if (
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0
    ) {
      fail(`${where}.duration must be a finite non-negative number`);
    }

    const rawDependencies = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`${where}.dependsOn must be an array`);
    }

    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex++) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${where}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${where}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: raw.id, duration: raw.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) {
        fail(`task ${task.id} depends on unknown task: ${dependency}`);
      }
    }
  }

  return tasks;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort(compareIds)]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    positions.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (state.get(dependency) === 1) {
        const start = positions.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    positions.delete(id);
    state.set(id, 2);
    return null;
  }

  const ids = tasks.map((task) => task.id).sort(compareIds);
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();

  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.get(dependency)!.push(task.id);
    }
  }
  for (const ids of dependents.values()) ids.sort(compareIds);

  let ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort(compareIds);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle?.join(" -> ") ?? "detected"}`);
  }

  const earliest: Record<string, Timing> = {};
  const layerById = new Map<string, number>();
  const pathById = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    const start = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, earliest[dependency].finish),
      0,
    );
    const finish = start + task.duration;
    earliest[id] = { start, finish };

    const layer = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, layerById.get(dependency)! + 1),
      0,
    );
    layerById.set(id, layer);

    const pathCandidates: string[][] = [];
    if (start === 0) pathCandidates.push([id]);
    for (const dependency of task.dependsOn) {
      if (earliest[dependency].finish === start) {
        pathCandidates.push([...pathById.get(dependency)!, id]);
      }
    }
    pathCandidates.sort(compareSequences);
    pathById.set(id, pathCandidates[0]);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = layerById.get(id)!;
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort(compareIds);

  const totalDuration = tasks.reduce(
    (maximum, task) => Math.max(maximum, earliest[task.id].finish),
    0,
  );
  const criticalCandidates = tasks
    .filter((task) => earliest[task.id].finish === totalDuration)
    .map((task) => pathById.get(task.id)!);
  criticalCandidates.sort(compareSequences);

  return {
    order,
    layers,
    earliest,
    totalDuration,
    criticalPath: criticalCandidates[0] ?? [],
  };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) fail("usage: dependency-planner plan INPUT.json");
  if (args[0] !== "plan") fail(`unknown command: ${args[0]}`);
  if (args.length < 2) fail("missing input file");
  if (args.length > 2) fail(`unknown argument or flag: ${args[2]}`);

  const inputPath = args[1];
  let text: string;
  try {
    text = await Bun.file(inputPath).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read input file ${inputPath}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(parseTasks(input))));
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
