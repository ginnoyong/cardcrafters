/**
 * BullMQ-backed ImageQueue (build-phase step 2) — the production flavor,
 * selected by createImageQueue(process.env.REDIS_URL) when Redis is present.
 *
 * Contract (mirrors the memory queue's documented semantics):
 *  - Queue name `cc:item-image`; job payload = ImageJob verbatim.
 *  - Default worker concurrency 4, overridable via CC_IMAGE_CONCURRENCY.
 *  - Worker retries 0: the HANDLER owns retries (the AiRouter already retries
 *    the primary model and walks fallbacks). Bull only surfaces handler
 *    exceptions as failed jobs, logged here.
 *  - Completed/failed jobs are pruned (removeOnComplete/removeOnFail) so the
 *    Redis key space cannot grow unbounded across long games.
 *
 * The Bull Queue + Worker instances are owned by this module: `close()` shuts
 * the worker down (waits for in-flight handlers to finish) and closes the
 * shared ioredis connection. The server factory calls it on shutdown.
 */

import { Queue, Worker } from "bullmq";
import Redis from "ioredis";

import type { ImageJob, ImageQueue } from "./queue";

export const IMAGE_QUEUE_NAME = "cc-item-image";
// NOTE: the brief asked for 'cc:item-image', but the installed BullMQ
// (v5.81) throws "Queue name cannot contain :" — the dash form is the
// functional equivalent.

/** Default worker concurrency; env-overridable (same knob as the memory queue). */
export function imageConcurrency(): number {
  const parsed = Number(process.env.CC_IMAGE_CONCURRENCY);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 4;
}

export interface BullMqImageQueue extends ImageQueue {
  /** Graceful shutdown: worker.close() (drains in-flight) + queue + redis. */
  close(): Promise<void>;
}

export function createBullMqImageQueue(
  redisUrl: string,
  handler: (job: ImageJob) => Promise<void>,
): BullMqImageQueue {
  // Worker requires maxRetriesPerRequest: null (commands must not fail while
  // blocking for the next job when redis hiccups).
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const queue = new Queue<ImageJob>(IMAGE_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // attempts: 1 → Bull-level retries are 0 by design (handler owns them).
      attempts: 1,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  });

  const worker = new Worker<ImageJob>(
    IMAGE_QUEUE_NAME,
    async (job) => handler(job.data),
    { connection, concurrency: imageConcurrency() },
  );
  worker.on("failed", (job, err) => {
    const itemId = job?.data?.itemId ?? "unknown";
    console.error(`[queue] bullmq image job for item ${itemId} failed:`, err.message);
  });

  return {
    async enqueue(job: ImageJob): Promise<void> {
      await queue.add("item-image", job);
    },
    async close(): Promise<void> {
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}