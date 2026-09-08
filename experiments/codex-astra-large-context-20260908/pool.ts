// Stop dispatch on the first error, but drain all already-started work before returning.
// In particular, global host files must not be restored while another worker is still running.
export async function runPool<T>(items: T[], concurrency: number, task: (item: T, worker: number) => Promise<void>, stopped = () => false) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency")
  let next = 0
  let failure: unknown
  let failed = false
  async function worker(id: number) {
    while (!failed && !stopped()) {
      const index = next++
      if (index >= items.length) return
      try { await task(items[index]!, id) }
      catch (error) { if (!failed) failure = error; failed = true }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, index) => worker(index + 1)))
  if (failed) throw failure
}
