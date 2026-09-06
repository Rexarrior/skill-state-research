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

interface PathNode {
  id: string;
  previous?: PathNode;
  depth: number;
}

class InputError extends Error {}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateInput(value: unknown): Task[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(`input must be an object, got ${describe(value)}`);
  }

  const tasksValue = (value as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksValue)) {
    throw new InputError(`"tasks" must be an array, got ${describe(tasksValue)}`);
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < tasksValue.length; index++) {
    const raw = tasksValue[index];
    const at = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new InputError(`${at} must be an object, got ${describe(raw)}`);
    }

    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new InputError(`${at}.id must be a non-empty string`);
    }
    if (ids.has(item.id)) {
      throw new InputError(`duplicate task id "${item.id}"`);
    }
    ids.add(item.id);

    if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration < 0) {
      throw new InputError(`${at}.duration must be a finite non-negative number`);
    }

    const dependencies = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(dependencies)) {
      throw new InputError(`${at}.dependsOn must be an array of strings`);
    }

    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
      const dependency = dependencies[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new InputError(`${at}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (seenDependencies.has(dependency)) {
        throw new InputError(`${at}.dependsOn contains duplicate id "${dependency}"`);
      }
      seenDependencies.add(dependency);
    }

    tasks.push({ id: item.id, duration: item.duration, dependsOn: [...dependencies] as string[] });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new InputError(`task "${task.id}" cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new InputError(`task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
  }

  return tasks;
}

class StringMinHeap {
  private readonly values: string[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: string): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.values[parent] <= value) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): string {
    const result = this.values[0];
    const last = this.values.pop()!;
    if (this.values.length === 0) return result;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child = right < this.values.length && this.values[right] < this.values[left] ? right : left;
      if (this.values[child] >= last) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return result;
  }
}

function compareSequences(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function sequenceFromPath(path: PathNode): string[] {
  const sequence = new Array<string>(path.depth);
  let current: PathNode | undefined = path;
  while (current) {
    sequence[current.depth - 1] = current.id;
    current = current.previous;
  }
  return sequence;
}

function comparePaths(left: PathNode, right: PathNode): number {
  if (left === right) return 0;

  let leftAligned = left;
  let rightAligned = right;
  while (leftAligned.depth > rightAligned.depth) leftAligned = leftAligned.previous!;
  while (rightAligned.depth > leftAligned.depth) rightAligned = rightAligned.previous!;
  if (leftAligned === rightAligned) return left.depth < right.depth ? -1 : 1;

  return compareSequences(sequenceFromPath(left), sequenceFromPath(right));
}

function findCycle(tasks: Task[]): string[] {
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependsOn].sort()]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  for (const root of tasks.map((task) => task.id).sort()) {
    if ((state.get(root) ?? 0) !== 0) continue;

    const frames: Array<{ id: string; nextDependency: number }> = [{ id: root, nextDependency: 0 }];
    state.set(root, 1);
    stackIndex.set(root, stack.length);
    stack.push(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const taskDependencies = dependencies.get(frame.id)!;
      if (frame.nextDependency >= taskDependencies.length) {
        frames.pop();
        stack.pop();
        stackIndex.delete(frame.id);
        state.set(frame.id, 2);
        continue;
      }

      const dependency = taskDependencies[frame.nextDependency++];
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        state.set(dependency, 1);
        stackIndex.set(dependency, stack.length);
        stack.push(dependency);
        frames.push({ id: dependency, nextDependency: 0 });
      } else if (dependencyState === 1) {
        const start = stackIndex.get(dependency)!;
        return [...stack.slice(start), dependency];
      }
    }
  }
  return [];
}

export function createPlan(input: unknown): Plan {
  const tasks = validateInput(input);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));

  for (const task of tasks) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  for (const ids of dependents.values()) ids.sort();

  const ready = new StringMinHeap();
  for (const task of tasks) {
    if (task.dependsOn.length === 0) ready.push(task.id);
  }
  const order: string[] = [];
  while (ready.size > 0) {
    const id = ready.pop();
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (order.length !== tasks.length) {
    const cycle = findCycle(tasks);
    throw new InputError(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const earliest = Object.create(null) as Record<string, { start: number; finish: number }>;
  const layerById = new Map<string, number>();
  const pathById = new Map<string, PathNode>();
  let totalDuration = 0;
  let criticalPathNode: PathNode | undefined;

  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0;
    let layer = 0;
    let prefix: PathNode | undefined;

    for (const dependency of task.dependsOn) {
      const finish = earliest[dependency].finish;
      const dependencyPath = pathById.get(dependency)!;
      if (
        prefix === undefined ||
        finish > start ||
        (finish === start && comparePaths(dependencyPath, prefix) < 0)
      ) {
        start = finish;
        prefix = dependencyPath;
      }
      layer = Math.max(layer, layerById.get(dependency)! + 1);
    }

    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new InputError(`schedule time overflows for task "${id}"`);
    }
    const path: PathNode = { id, previous: prefix, depth: (prefix?.depth ?? 0) + 1 };
    earliest[id] = { start, finish };
    layerById.set(id, layer);
    pathById.set(id, path);

    if (
      criticalPathNode === undefined ||
      finish > totalDuration ||
      (finish === totalDuration && comparePaths(path, criticalPathNode) < 0)
    ) {
      totalDuration = finish;
      criticalPathNode = path;
    }
  }

  const layerCount = tasks.length === 0 ? 0 : Math.max(...layerById.values()) + 1;
  const layers = Array.from({ length: layerCount }, () => [] as string[]);
  for (const [id, layer] of layerById) layers[layer].push(id);
  for (const layer of layers) layer.sort();

  const criticalPath = criticalPathNode ? sequenceFromPath(criticalPathNode) : [];
  return { order, layers, earliest, totalDuration, criticalPath };
}

function usage(): string {
  return "Usage: bun run src/cli.ts plan INPUT.json";
}

export async function main(args: string[]): Promise<void> {
  if (args.length === 0) throw new InputError(usage());
  if (args[0].startsWith("-")) throw new InputError(`unknown flag "${args[0]}"\n${usage()}`);
  if (args[0] !== "plan") throw new InputError(`unknown command "${args[0]}"\n${usage()}`);
  if (args.length < 2) throw new InputError(`missing input file\n${usage()}`);
  if (args[1].startsWith("-")) throw new InputError(`unknown flag "${args[1]}"\n${usage()}`);
  if (args.length > 2) {
    const extra = args[2];
    const message = extra.startsWith("-") ? `unknown flag "${extra}"` : `unexpected argument "${extra}"`;
    throw new InputError(`${message}\n${usage()}`);
  }

  let source: string;
  try {
    source = await Bun.file(args[1]).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read "${args[1]}": ${message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`invalid JSON in "${args[1]}": ${message}`);
  }

  console.log(JSON.stringify(createPlan(input)));
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
