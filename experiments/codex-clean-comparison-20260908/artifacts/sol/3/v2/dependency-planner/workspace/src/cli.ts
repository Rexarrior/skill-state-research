type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = { start: number; finish: number };

type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function parseTasks(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("input must be a JSON object");
  }

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) fail('"tasks" must be an array');

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < root.tasks.length; index += 1) {
    const raw = root.tasks[index];
    const label = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }

    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(item.id)) fail(`duplicate task id: ${item.id}`);
    ids.add(item.id);

    if (
      typeof item.duration !== "number" ||
      !Number.isFinite(item.duration) ||
      item.duration < 0
    ) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const rawDependencies = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(rawDependencies)) {
      fail(`${label}.dependsOn must be an array of unique strings`);
    }
    const dependencySet = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
      const dependency = rawDependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        fail(`${label}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencySet.has(dependency)) {
        fail(`${label}.dependsOn contains duplicate id: ${dependency}`);
      }
      dependencySet.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: item.id, duration: item.duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown id: ${dependency}`);
    }
  }

  return tasks;
}

function findCycle(tasks: Task[]): string[] | null {
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...task.dependsOn].sort((a, b) => a.localeCompare(b))]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      } else if (state.get(dependency) === 1) {
        const start = stackIndex.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }

    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  }

  const ids = tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

function createPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  const remaining = new Map<string, number>();

  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const values of dependents.values()) values.sort((a, b) => a.localeCompare(b));

  let ready = tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];
  const layers: string[][] = [];

  while (ready.length > 0) {
    const layer = ready;
    layers.push(layer);
    order.push(...layer);
    const next: string[] = [];
    for (const id of layer) {
      for (const dependent of dependents.get(id)!) {
        const count = remaining.get(dependent)! - 1;
        remaining.set(dependent, count);
        if (count === 0) next.push(dependent);
      }
    }
    ready = next.sort((a, b) => a.localeCompare(b));
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    fail(`dependency cycle: ${cycle?.join(" -> ") ?? "detected"}`);
  }

  const earliest: Record<string, Timing> = {};
  const bestPath = new Map<string, string[]>();
  let totalDuration = 0;

  for (const id of order) {
    const task = byId.get(id)!;
    const start = task.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, earliest[dependency].finish),
      0,
    );
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);

    const candidates: string[][] = [];
    if (start === 0) candidates.push([id]);
    for (const dependency of task.dependsOn) {
      if (earliest[dependency].finish === start) {
        candidates.push([...bestPath.get(dependency)!, id]);
      }
    }
    candidates.sort(compareSequences);
    bestPath.set(id, candidates[0]);
  }

  const criticalCandidates = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => bestPath.get(id)!)
    .sort(compareSequences);

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
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let text: string;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${args[1]}: ${detail}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid JSON: ${detail}`);
  }

  console.log(JSON.stringify(createPlan(parseTasks(value))));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
