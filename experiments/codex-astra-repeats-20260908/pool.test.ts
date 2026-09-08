import { expect, test } from "bun:test"
import { runPool } from "./pool"

test("100 cells execute once with at most five simultaneous workers", async () => {
  let active = 0, peak = 0
  const finished: number[] = []
  await runPool(Array.from({ length: 100 }, (_, i) => i), 5, async item => {
    active++
    peak = Math.max(active, peak)
    await Bun.sleep(2)
    finished.push(item)
    active--
  })
  expect(peak).toBe(5)
  expect(active).toBe(0)
  expect(new Set(finished).size).toBe(100)
})

test("first failure stops dispatch and waits for active workers before rejecting", async () => {
  const started: number[] = [], finished: number[] = []
  await expect(runPool(Array.from({ length: 100 }, (_, i) => i), 5, async item => {
    started.push(item)
    if (item === 0) { await Bun.sleep(1); throw new Error("fixture failure") }
    await Bun.sleep(15)
    finished.push(item)
  })).rejects.toThrow("fixture failure")
  expect(started).toEqual([0, 1, 2, 3, 4])
  expect(finished.sort()).toEqual([1, 2, 3, 4])
})
