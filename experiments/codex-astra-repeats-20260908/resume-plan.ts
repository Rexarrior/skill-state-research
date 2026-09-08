export type CampaignCell = {
  repetition: number, project: string, mode: string, status: string, source: string | null,
  startedAt: string | null, endedAt: string | null, worker: number | null,
}

export function remainingCells(cells: CampaignCell[]) {
  const keys = cells.map(cell => `${cell.repetition}/${cell.project}/${cell.mode}`)
  if (cells.length !== 100 || new Set(keys).size !== 100) throw new Error("Incomplete or duplicated original schedule")
  for (const cell of cells) {
    if (cell.status === "complete") {
      if (!cell.source || !cell.startedAt || !cell.endedAt) throw new Error("Completed cell lacks provenance")
      continue
    }
    if (cell.status !== "pending" || cell.source || cell.startedAt || cell.endedAt || cell.worker !== null)
      throw new Error("Refusing to retry a started or ambiguous cell")
  }
  // Preserve original order, including failed/timeout outcomes marked complete by the runner.
  return cells.filter(cell => cell.status === "pending")
}
