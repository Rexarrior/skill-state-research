import { expect, test } from "bun:test"
import { remainingCells, type CampaignCell } from "./resume-plan"

function fixture(): CampaignCell[] {
  return Array.from({ length: 100 }, (_, index) => ({ repetition: Math.floor(index / 20) + 1,
    project: "project-" + Math.floor((index % 20) / 4), mode: "mode-" + index % 4,
    status: index < 35 ? "complete" : "pending", source: index < 35 ? "saved-" + index : null,
    startedAt: index < 35 ? "start" : null, endedAt: index < 35 ? "end" : null,
    worker: index < 35 ? index % 5 + 1 : null }))
}

test("resume selects precisely the 65 unstarted cells without touching 35 outcomes", () => {
  const cells = fixture(), before = JSON.stringify(cells)
  expect(remainingCells(cells)).toEqual(cells.slice(35))
  expect(JSON.stringify(cells)).toBe(before)
})

test("ambiguous, started and duplicate cells cannot be silently rerun", () => {
  for (const field of ["status", "source", "startedAt", "endedAt", "worker"] as const) {
    const cells = fixture()
    Object.assign(cells[35]!, { [field]: field === "worker" ? 1 : "set" })
    expect(() => remainingCells(cells)).toThrow("Refusing")
  }
  const cells = fixture()
  cells[35] = cells[36]!
  expect(() => remainingCells(cells)).toThrow("duplicated")
})
