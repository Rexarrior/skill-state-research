export interface TaskInput {
  id: string;
  duration: number;
  dependsOn?: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIds(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function validate(input: unknown): Task[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("input must be a JSON object");
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const label = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${label} must be an object`);
    }

    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) fail(`duplicate task id: ${candidate.id}`);
    ids.add(candidate.id);

    if (
      typeof candidate.duration !== "number" ||
      !Number.isFinite(candidate.duration) ||
      candidate.duration < 0
    ) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependencies = candidate.dependsOn === undefined ? [] : candidate.dependsOn;
    if (!Array.isArray(dependencies)) fail(`${label}.dependsOn must be an array`);

    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      seenDependencies.add(dependency);
    }

    tasks.push({
      id: candidate.id,
      duration: candidate.duration,
      dependsOn: [...dependencies] as string[],
    });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown id: ${dependency}`);
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const positions = new Map<string, number>();

  interface Frame {
    id: string;
    dependencies: string[];
    nextDependency: number;
  }

  for (const startingId of [...byId.keys()].sort(compareIds)) {
    if (state.has(startingId)) continue;

    state.set(startingId, 1);
    positions.set(startingId, path.length);
    path.push(startingId);
    const frames: Frame[] = [{
      id: startingId,
      dependencies: [...byId.get(startingId)!.dependsOn].sort(compareIds),
      nextDependency: 0,
    }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.nextDependency === frame.dependencies.length) {
        frames.pop();
        path.pop();
        positions.delete(frame.id);
        state.set(frame.id, 2);
        continue;
      }

      const dependency = frame.dependencies[frame.nextDependency++]!;
      if (state.get(dependency) === 1) {
        return [...path.slice(positions.get(dependency)), dependency];
      }
      if (!state.has(dependency)) {
        state.set(dependency, 1);
        positions.set(dependency, path.length);
        path.push(dependency);
        frames.push({
          id: dependency,
          dependencies: [...byId.get(dependency)!.dependsOn].sort(compareIds),
          nextDependency: 0,
        });
      }
    }
  }
  return undefined;
}

export function createPlan(input: unknown): Plan {
  const tasks = validate(input);
  const cycle = findCycle(tasks);
  if (cycle) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks) {
    remainingDependencies.set(task.id, task.dependsOn.length);
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
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds);
      }
    }
  }

  const earliest: Record<string, { start: number; finish: number }> = {};
  const layerById = new Map<string, number>();
  const bestWeight = new Map<string, number>();
  const bestPath = new Map<string, string[]>();

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let pathWeight = task.duration;
    let path = [id];

    for (const dependency of task.dependsOn) {
      const dependencyFinish = earliest[dependency]!.finish;
      start = Math.max(start, dependencyFinish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);

      const candidateWeight = bestWeight.get(dependency)! + task.duration;
      const candidatePath = [...bestPath.get(dependency)!, id];
      if (
        candidateWeight > pathWeight ||
        (candidateWeight === pathWeight && comparePaths(candidatePath, path) < 0)
      ) {
        pathWeight = candidateWeight;
        path = candidatePath;
      }
    }

    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    bestWeight.set(id, pathWeight);
    bestPath.set(id, path);
  }

  const layers: string[][] = [];
  for (const [id, layer] of layerById) {
    (layers[layer] ??= []).push(id);
  }
  for (const layer of layers) layer.sort(compareIds);

  let totalDuration = 0;
  for (const timing of Object.values(earliest)) totalDuration = Math.max(totalDuration, timing.finish);

  let criticalPath: string[] = [];
  for (const id of order) {
    if (bestWeight.get(id) !== totalDuration) continue;
    const candidate = bestPath.get(id)!;
    if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) criticalPath = candidate;
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0) fail("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") {
    if (args[0]!.startsWith("-")) fail(`unknown flag: ${args[0]}`);
    fail(`unknown command: ${args[0]}`);
  }
  const unknownFlag = args.slice(1).find((argument) => argument.startsWith("-"));
  if (unknownFlag) fail(`unknown flag: ${unknownFlag}`);
  if (args.length !== 2) fail("usage: bun run src/cli.ts plan INPUT.json");

  let text: string;
  try {
    text = await Bun.file(args[1]!).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${args[1]}: ${detail}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON in ${args[1]}: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
