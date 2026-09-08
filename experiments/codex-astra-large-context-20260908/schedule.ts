export function schedule() {
  const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
  const modes = ["baseline", "paper", "v2", "v3"]
  return Array.from({ length: 5 }, (_, repeat) => {
    const order = [...projects.slice(repeat), ...projects.slice(0, repeat)]
    return order.flatMap((project, position) => {
      const offset = (repeat + position) % 4
      return [...modes.slice(offset), ...modes.slice(0, offset)].map(mode => ({
        repetition: repeat + 1, project, mode, status: "pending", source: null as string | null,
        startedAt: null as string | null, endedAt: null as string | null, worker: null as number | null,
      }))
    })
  }).flat()
}
