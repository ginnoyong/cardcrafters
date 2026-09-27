/**
 * Image queue seam (build-phase step 1 — INTERFACE ONLY).
 *
 * The prompt pipeline hands every fully-accepted (status GENERATING) item to
 * an ImageQueue; step 2 replaces the injected handler with the real image
 * worker. Until then `createMemoryImageQueue()` runs with a no-op handler, so
 * items simply stay GENERATING.
 */

/** One pending image-generation job (exactly what the worker needs). */
export interface ImageJob {
  itemId: string;
  gameId: string;
  teamId: string;
  playerId: string;
  /** Exact raw prompt text (the Item row keeps it verbatim). */
  prompt: string;
  /** Validated, normalized subject extracted by prompt_validation. */
  subject: string | null;
}

export interface ImageQueue {
  enqueue(job: ImageJob): Promise<void>;
}

/**
 * FIFO in-memory image queue. The handler is the injection point for step 2;
 * with the default no-op handler the queue is a pure drain (enqueue resolves
 * immediately, the (empty) handler still runs FIFO in the background).
 * Handler errors are logged and swallowed — a failed job is the worker's
 * concern (it marks the Item FAILED), never the enqueue caller's.
 */
export function createMemoryImageQueue(
  handler: (job: ImageJob) => Promise<void> = async () => {},
): ImageQueue & { size(): number } {
  const jobs: ImageJob[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (jobs.length > 0) {
        const job = jobs.shift()!;
        try {
          await handler(job);
        } catch (err) {
          console.error(`[queue] image job for item ${job.itemId} failed:`, err);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    async enqueue(job: ImageJob): Promise<void> {
      jobs.push(job);
      // Fire-and-forget: enqueue must never block submission on image work.
      void drain();
    },
    size(): number {
      return jobs.length;
    },
  };
}
