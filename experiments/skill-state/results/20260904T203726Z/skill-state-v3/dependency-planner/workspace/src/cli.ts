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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(input: unknown): Task[] {
  if (!isRecord(input) || !Array.isArray(input.tasks)) {
    fail('Invalid input: "tasks" must be an array.');
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of input.tasks.entries()) {
    if (!isRecord(raw)) fail(`Invalid task at index ${index}: must be an object.`);
    const { id, duration, dependsOn = [] } = raw;
    if (typeof id !== "string" || id.length === 0) {
      fail(`Invalid task at index ${index}: "id" must be a non-empty string.`);
    }
    if (ids.has(id)) fail(`Invalid input: duplicate task id "${id}".`);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      fail(`Invalid task "${id}": "duration" must be a finite non-negative number.`);
    }
    if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== "string")) {
      fail(`Invalid task "${id}": "dependsOn" must be an array of strings.`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail(`Invalid task "${id}": "dependsOn" must contain unique ids.`);
    }
    if (dependsOn.includes(id)) fail(`Invalid task "${id}": cannot depend on itself.`);
    ids.add(id);
    tasks.push({ id, duration, dependsOn });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) fail(`Invalid task "${task.id}": unknown dependency "${dependency}".`);
    }
  }
  return tasks;
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const trail: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    trail.push(id);
    for (const dependency of [...byId.get(id)!.dependsOn].sort()) {
      if (state.get(dependency) === 1) return [...trail.slice(trail.indexOf(dependency)), dependency];
      if (state.get(dependency) !== 2) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    trail.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!state.has(task.id)) {
      const cycle = visit(task.id);
      if (cycle) return cycle;
    }
  }
}

function plan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(tasks, byId);
  if (cycle) fail(`Cycle detected: ${cycle.join(" -> ")}`);

  const children = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dependency of task.dependsOn) children.get(dependency)!.push(task.id);

  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of children.get(id)!.sort()) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  const earliest: Plan["earliest"] = {};
  const paths: Record<string, string[]> = {};
  const layers: string[][] = [];
  for (const id of order) {
    const task = byId.get(id)!;
    const start = task.dependsOn.reduce((maximum, dependency) => Math.max(maximum, earliest[dependency].finish), 0);
    earliest[id] = { start, finish: start + task.duration };
    const layer = task.dependsOn.reduce((maximum, dependency) => Math.max(maximum, (layers.findIndex((items) => items.includes(dependency)) + 1)), 0);
    (layers[layer] ??= []).push(id);
    const latestDependencies = task.dependsOn.filter((dependency) => earliest[dependency].finish === start);
    const candidates = latestDependencies.map((dependency) => [...paths[dependency], id]);
    paths[id] = candidates.length === 0 ? [id] : candidates.sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")))[0];
  }
  for (const layer of layers) layer.sort();

  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id].finish), 0);
  const criticalPath = order
    .filter((id) => earliest[id].finish === totalDuration)
    .map((id) => paths[id])
    .sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")))[0] ?? [];
  return { order, layers, earliest, totalDuration, criticalPath };
}

const [command, inputPath, ...extra] = process.argv.slice(2);
if (command !== "plan" || !inputPath || extra.length > 0) {
  fail("Usage: bun run src/cli.ts plan INPUT.json");
}

let input: unknown;
try {
  input = JSON.parse(await Bun.file(inputPath).text());
} catch (error) {
  fail(`Unable to read valid JSON from "${inputPath}": ${error instanceof Error ? error.message : String(error)}`);
}
console.log(JSON.stringify(plan(validate(input))));
