export type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) throw new Error('Input must contain a tasks array');
  const ids = new Set<string>();
  const tasks = input.tasks.map((item: unknown, index: number): Task => {
    if (!record(item)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = item;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    const deps = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(deps) || deps.some(dep => typeof dep !== 'string'))
      throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    if (new Set(deps).size !== deps.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (deps.includes(id)) throw new Error(`Task ${id}: self-dependency (${id} -> ${id})`);
    return { id, duration, dependsOn: [...deps] };
  });
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
  return tasks;
}

function cycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    const position = new Map<string, number>([[root, 0]]);
    color.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = children.get(frame.id)![frame.next++];
      if (next === undefined) {
        color.set(frame.id, 2);
        position.delete(frame.id);
        stack.pop();
      } else if (color.get(next) === 1) {
        return [...stack.slice(position.get(next)!).map(entry => entry.id), next];
      } else if (!color.has(next)) {
        color.set(next, 1);
        position.set(next, stack.length);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error('Unable to locate cycle');
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  for (const list of children.values()) list.sort(compare);
  // A binary min-heap keeps ready-task selection deterministic and efficient.
  const ready: string[] = [];
  function push(id: string) {
    let i = ready.length;
    ready.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(ready[p]!, id) <= 0) break;
      ready[i] = ready[p]!;
      i = p;
    }
    ready[i] = id;
  }
  function pop(): string {
    const first = ready[0]!;
    const last = ready.pop()!;
    if (ready.length) {
      let i = 0;
      while (2 * i + 1 < ready.length) {
        let child = 2 * i + 1;
        if (child + 1 < ready.length && compare(ready[child + 1]!, ready[child]!) < 0) child++;
        if (compare(last, ready[child]!) <= 0) break;
        ready[i] = ready[child]!;
        i = child;
      }
      ready[i] = last;
    }
    return first;
  }
  for (const id of ids) if (pending.get(id) === 0) push(id);
  const order: string[] = [];
  const levels = new Map<string, number>();
  const times = new Map<string, Timing>();
  const layers: string[][] = [];
  let totalDuration = 0;
  while (ready.length) {
    const id = pop();
    const task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, times.get(dep)!.finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Task ${id}: schedule duration exceeds finite numeric range`);
    times.set(id, { start, finish });
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = pending.get(child)! - 1;
      pending.set(child, count);
      if (count === 0) push(child);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${cycle(ids, children).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);
  // Tight edges preserve longest-path timing. Mark those that can reach an
  // optimal endpoint, then greedily choose the smallest full id sequence.
  const reachesEnd = new Set<string>();
  const tight = (id: string, child: string) => times.get(id)!.finish === times.get(child)!.start;
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (times.get(id)!.finish === totalDuration || children.get(id)!.some(child => tight(id, child) && reachesEnd.has(child)))
      reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => times.get(id)!.start === 0 && reachesEnd.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    if (times.get(current)!.finish === totalDuration) break;
    const id = current;
    current = children.get(id)!.find(child => tight(id, child) && reachesEnd.has(child));
  }
  const earliest: Record<string, Timing> = Object.create(null);
  for (const id of ids) earliest[id] = times.get(id)!;
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1]!.startsWith('-'))
      throw new Error('Usage: bun run src/cli.ts plan INPUT.json (no flags supported)');
    const text = await Bun.file(args[1]!).text();
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new Error('Invalid JSON in input file'); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
