/**
 * Image queue seam (build-phase steps 1+2).
 *
 * The prompt pipeline hands every fully-accepted (status GENERATING) item to
 * an ImageQueue. Step 2 wires the real item-image worker handler
 * (flows/item-image.ts) and adds a BullMQ implementation for production
 * (REDIS_URL); tests keep using the in-memory queue below.
 *
 * RETRY OWNERSHIP: retries live in the HANDLER's AI call chain (the AiRouter
 * already retries models and falls back); the queue itself retries 0 times —
 * a handler exception fails the job (logged), never retried by the queue.
 */

/** One pending image-generation job (exactly what the worker needs). */
export interface ImageJob {
  itemId: string;
  gameId: string;
  teamId: string;
  playerId: string;
  /** The round the item belongs to (used for room addressing / envelopes). */
  round: number;
  /** Exact raw prompt text (the Item row keeps it verbatim). */
  prompt: string;
  /** Validated, normalized subject extracted by prompt_validation. */
  subject: string | null;
}

export interface ImageQueue {
  enqueue(job: ImageJob): Promise<void>;
}

/**
 * FIFO in-memory image queue with CONCURRENCY LIMITING (step 2): up to N
 * handlers run in parallel (default 4, env CC_IMAGE_CONCURRENCY); jobs start
 * strictly in enqueue order, and at most N are in flight at once — mirrors
 * the BullMQ worker's `concurrency` so tests exercise the same semantics.
 *
 * The handler is the injection point for the real worker; with the default
 * no-op handler the queue is a pure drain. Handler errors are logged and
 * swallowed — a failed job is the worker's concern (it marks the Item
 * FAILED), never the enqueue caller's.
 */
export function createMemoryImageQueue(
  handler: (job: ImageJob) => Promise<void> = async () => {},
  opts: { concurrency?: number } = {},
): ImageQueue & {
  /** Jobs still waiting to start (never includes in-flight ones). */
  size(): number;
  /** Handlers currently running (≤ concurrency). */
  inFlight(): number;
  /** Resolves when every accepted job has finished (tests). */
  drained(): Promise<void>;
} {
  const parsed = Number(opts.concurrency ?? process.env.CC_IMAGE_CONCURRENCY);
  const concurrency = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 4;
  const pending: ImageJob[] = [];
  let inFlightCount = 0;

  /** Start handlers while below the concurrency cap and jobs are waiting. */
  function pump(): void {
    while (inFlightCount < concurrency && pending.length > 0) {
      const job = pending.shift()!;
      inFlightCount++;
      void handler(job)
        .catch((err) => {
          console.error(`[queue] image job for item ${job.itemId} failed:`, err);
        })
        .finally(() => {
          inFlightCount--;
          pump();
        });
    }
  }

  return {
    async enqueue(job: ImageJob): Promise<void> {
      pending.push(job);
      // Fire-and-forget: enqueue must never block submission on image work.
      pump();
    },
    size(): number {
      return pending.length;
    },
    inFlight(): number {
      return inFlightCount;
    },
    drained(): Promise<void> {
      return new Promise((resolve) => {
        const check = (): void => {
          if (pending.length === 0 && inFlightCount === 0) resolve();
          else setTimeout(check, 5);
        };
        check();
      });
    },
  };
}
