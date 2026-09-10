import { schedule } from "./schedule"

type Cell = ReturnType<typeof schedule>[number]
type Prior = { status: string, isolation: string, cells: Cell[] }

export function resumeCells(prior: Prior) {
  if (prior.status !== "interrupted" || prior.isolation !== "restored")
    throw new Error("Prior campaign must be interrupted with verified restoration")
  const key = (cell: Cell) => `${cell.model}/${cell.repetition}/${cell.project}/${cell.mode}`
  if (JSON.stringify(prior.cells.map(key)) !== JSON.stringify(schedule().map(key)))
    throw new Error("Prior schedule differs")
  return prior.cells.map(cell => {
    if (cell.status === "complete") {
      if (!cell.source) throw new Error("Completed cell has no source")
      return { ...cell, attempt: 1, carried: true, previousAttempt: null }
    }
    if (cell.status !== "pending" && cell.status !== "interrupted")
      throw new Error("Unexpected prior cell status; inspect rather than retry")
    return { ...cell, status: "pending", source: null, startedAt: null, endedAt: null, worker: null,
      attempt: cell.status === "interrupted" ? 2 : 1, carried: false,
      previousAttempt: cell.status === "interrupted" ? { ...cell } : null }
  })
}

export async function finalizeRecovery(
  state: { status: string, isolation: string, stopReason: string | null },
  save: () => Promise<unknown>,
  restore: () => Promise<{ failures: { original: string, error: string }[] }>,
) {
  state.isolation = "restoring"
  // The terminal execution status must reach disk even if restoration throws.
  try { await save() }
  catch (error) {
    state.stopReason = `${state.stopReason ?? "Execution finished"}; checkpoint: ${error instanceof Error ? error.message : "failed"}`
  }
  try {
    const receipt = await restore()
    if (receipt.failures.length) throw new Error(JSON.stringify(receipt.failures))
    state.isolation = "restored"
  } catch (error) {
    state.isolation = "restore-failed"
    state.status = "needs-attention"
    state.stopReason = `${state.stopReason ?? "Execution finished"}; restoration: ${error instanceof Error ? error.message : "failed"}`
  } finally {
    await save()
  }
}
