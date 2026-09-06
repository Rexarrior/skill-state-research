type RawTask = {
  id: string;
  duration: number;
  dependsOn: string[];
};

type Timing = {
  start: number;
  finish: number;
};

export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, Timing>;
  totalDuration: number;
  criticalPath: string[];
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePaths(left: string[], right: string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = compareStrings(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateInput(input: unknown): RawTask[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`input must be an object, got ${describe(input)}`);
  }

  const tasksValue = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new Error(`tasks must be an array, got ${describe(tasksValue)}`);
  }

  const tasks: RawTask[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index += 1) {
    const value = tasksValue[index];
    const location = `tasks[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${location} must be an object`);
    }

    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(task.id)) {
      throw new Error(`duplicate task id: ${JSON.stringify(task.id)}`);
    }
    ids.add(task.id);

    if (
      typeof task.duration !== "number" ||
      !Number.isFinite(task.duration) ||
      task.duration < 0
    ) {
      throw new Error(`${location}.duration must be a finite non-negative number`);
    }

    const dependencies = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new Error(`${location}.dependsOn must be an array`);
    }

    const seenDependencies = new Set<string>();
    const dependsOn: string[] = [];
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex += 1) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new Error(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new Error(
          `${location}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`,
        );
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    tasks.push({ id: task.id, duration: task.duration, dependsOn });
  }

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`tasks[${index}].dependsOn cannot contain its own id`);
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `tasks[${index}].dependsOn references unknown id ${JSON.stringify(dependency)}`,
        );
      }
    }
  }

  return tasks;
}

class MinHeap {
  private values: string[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: string): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareStrings(this.values[parent], value) <= 0) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): string {
    const first = this.values[0];
    const last = this.values.pop()!;
    if (this.values.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child =
        right < this.values.length && compareStrings(this.values[right], this.values[left]) < 0
          ? right
          : left;
      if (compareStrings(this.values[child], last) >= 0) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function findCycle(tasksById: Map<string, RawTask>): string[] {
  const state = new Map<string, 1 | 2>();
  const activeIndex = new Map<string, number>();

  for (const root of [...tasksById.keys()].sort(compareStrings)) {
    if (state.has(root)) continue;

    const stack: Array<{ id: string; dependencies: string[]; next: number }> = [];
    state.set(root, 1);
    activeIndex.set(root, 0);
    stack.push({
      id: root,
      dependencies: [...tasksById.get(root)!.dependsOn].sort(compareStrings),
      next: 0,
    });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next === frame.dependencies.length) {
        state.set(frame.id, 2);
        activeIndex.delete(frame.id);
        stack.pop();
        continue;
      }

      const dependency = frame.dependencies[frame.next];
      frame.next += 1;
      const dependencyState = state.get(dependency);
      if (dependencyState === 1) {
        const start = activeIndex.get(dependency)!;
        return [...stack.slice(start).map(({ id }) => id), dependency];
      }
      if (dependencyState === 2) continue;

      state.set(dependency, 1);
      activeIndex.set(dependency, stack.length);
      stack.push({
        id: dependency,
        dependencies: [...tasksById.get(dependency)!.dependsOn].sort(compareStrings),
        next: 0,
      });
    }
  }

  throw new Error("cycle detected");
}

function buildPath(
  end: string,
  criticalParent: Map<string, string | undefined>,
): string[] {
  const reversed: string[] = [];
  let current: string | undefined = end;
  while (current !== undefined) {
    reversed.push(current);
    current = criticalParent.get(current);
  }
  return reversed.reverse();
}

export function createPlan(tasks: RawTask[]): Plan {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
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
  for (const values of dependents.values()) values.sort(compareStrings);

  const ready = new MinHeap();
  for (const task of tasks) {
    if (task.dependsOn.length === 0) ready.push(task.id);
  }

  const order: string[] = [];
  const timingById = new Map<string, Timing>();
  const layerById = new Map<string, number>();
  const criticalParent = new Map<string, string | undefined>();
  const criticalPathFirst = new Map<string, string>();

  while (ready.size > 0) {
    const id = ready.pop();
    const task = tasksById.get(id)!;
    order.push(id);

    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, timingById.get(dependency)!.finish);
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }
    timingById.set(id, { start, finish: start + task.duration });
    layerById.set(id, layer);

    const longestDependencies = task.dependsOn.filter(
      (dependency) => timingById.get(dependency)!.finish === start,
    );
    let parent: string | undefined;
    for (const dependency of longestDependencies) {
      if (
        parent === undefined ||
        comparePaths(
          buildPath(dependency, criticalParent),
          buildPath(parent, criticalParent),
        ) < 0
      ) {
        parent = dependency;
      }
    }
    if (
      start === 0 &&
      parent !== undefined &&
      compareStrings(id, criticalPathFirst.get(parent)!) < 0
    ) {
      parent = undefined;
    }
    criticalParent.set(id, parent);
    criticalPathFirst.set(id, parent === undefined ? id : criticalPathFirst.get(parent)!);

    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (order.length !== tasks.length) {
    throw new Error(`dependency cycle detected: ${findCycle(tasksById).join(" -> ")}`);
  }

  let layerCount = 0;
  for (const layer of layerById.values()) layerCount = Math.max(layerCount, layer + 1);
  const layers = Array.from({ length: layerCount }, () => [] as string[]);
  for (const id of order) layers[layerById.get(id)!].push(id);
  for (const layer of layers) layer.sort(compareStrings);

  const earliest: Record<string, Timing> = Object.create(null) as Record<string, Timing>;
  for (const id of [...tasksById.keys()].sort(compareStrings)) {
    earliest[id] = timingById.get(id)!;
  }

  let totalDuration = 0;
  for (const { finish } of timingById.values()) {
    totalDuration = Math.max(totalDuration, finish);
  }
  let criticalPath: string[] = [];
  if (tasks.length > 0 && totalDuration === 0) {
    criticalPath = [[...tasksById.keys()].sort(compareStrings)[0]];
  } else {
    for (const id of [...tasksById.keys()].sort(compareStrings)) {
      if (timingById.get(id)!.finish !== totalDuration) continue;
      const candidate = buildPath(id, criticalParent);
      if (criticalPath.length === 0 || comparePaths(candidate, criticalPath) < 0) {
        criticalPath = candidate;
      }
    }
  }

  return { order, layers, earliest, totalDuration, criticalPath };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = args.find((argument) => argument.startsWith("-"));
  if (flag !== undefined) throw new Error(`unknown flag: ${flag}`);
  if (args.length === 0) throw new Error("usage: bun run src/cli.ts plan INPUT.json");
  if (args[0] !== "plan") throw new Error(`unknown command: ${args[0]}`);
  if (args.length !== 2) throw new Error("usage: bun run src/cli.ts plan INPUT.json");

  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${JSON.stringify(args[1])}: ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${JSON.stringify(args[1])}: ${message}`);
  }

  console.log(JSON.stringify(createPlan(validateInput(input))));
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
