type Task = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Input = { tasks: unknown };

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function validateInput(value: unknown): Task[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("input must be an object with a tasks array");
  }

  const input = value as Input;
  if (!Array.isArray(input.tasks)) fail("tasks must be an array");

  const ids = new Set<string>();
  const tasks: Task[] = input.tasks.map((raw, index) => {
    const label = `tasks[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    if (ids.has(item.id)) fail(`duplicate task id: ${item.id}`);
    ids.add(item.id);

    if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration < 0) {
      fail(`${label}.duration must be a finite non-negative number`);
    }

    const dependsOn = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      fail(`${label}.dependsOn must be an array of strings (got ${formatValue(dependsOn)})`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail(`${label}.dependsOn must not contain duplicates`);
    }
    if (dependsOn.includes(item.id)) fail(`${label}.dependsOn cannot contain its own id`);

    return { id: item.id, duration: item.duration, dependsOn: [...dependsOn] };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  return tasks;
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const sortedIds = tasks.map((task) => task.id).sort();

  function visit(id: string): string[] | undefined {
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
  }

  for (const id of sortedIds) {
    if (state.get(id) === undefined) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasks, byId);
  if (cycle) fail(`dependency cycle: ${cycle.join(" -> ")}`);

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort();

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
  const pathTo = new Map<string, string[]>();
  const layers: string[][] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let predecessorPath: string[] | undefined;
    for (const dependency of task.dependsOn) {
      const candidate = earliest[dependency].finish;
      const candidatePath = pathTo.get(dependency)!;
      if (
        predecessorPath === undefined ||
        candidate > start ||
        (candidate === start && comparePaths(candidatePath, predecessorPath) < 0)
      ) {
        start = candidate;
        predecessorPath = candidatePath;
      }
    }
    earliest[id] = { start, finish: start + task.duration };
    pathTo.set(id, [...(predecessorPath ?? []), id]);

    const layer = task.dependsOn.length === 0 ? 0 : Math.max(...task.dependsOn.map((dep) => layerOf.get(dep)! + 1));
    while (layers.length <= layer) layers.push([]);
    layers[layer].push(id);
    layerOf.set(id, layer);
  }
  for (const layer of layers) layer.sort();

  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const finish = earliest[id].finish;
    const path = pathTo.get(id)!;
    if (finish > totalDuration || (finish === totalDuration && comparePaths(path, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = path;
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

const layerOf = new Map<string, number>();

function comparePaths(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

async function main(): Promise<void> {
  const [command, inputPath, ...extra] = process.argv.slice(2);
  if (command !== "plan" || !inputPath || extra.length > 0) {
    fail("usage: bun run src/cli.ts plan INPUT.json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(inputPath).text());
  } catch (error) {
    fail(`cannot read valid JSON from ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(JSON.stringify(plan(validateInput(parsed))));
}

void main();
