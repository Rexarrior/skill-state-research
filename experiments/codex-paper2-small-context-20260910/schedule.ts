export function schedule() {
  const projects = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
  const models = ["gpt-5.6-sol", "gpt-6-astra"]
  return Array.from({ length: 5 }, (_, repeat) => {
    const order = [...projects.slice(repeat), ...projects.slice(0, repeat)]
    return order.flatMap((project, position) => {
      const offset = (repeat + position) % 2
      return [...models.slice(offset), ...models.slice(0, offset)].map(model => ({
        repetition: repeat + 1, project, model, mode: "paper2", status: "pending", source: null as string | null,
        startedAt: null as string | null, endedAt: null as string | null, worker: null as number | null,
      }))
    })
  }).flat()
}
