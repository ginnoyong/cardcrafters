/**
 * ImageQueue factory (build-phase step 2) — the single place that picks the
 * queue flavor:
 *  - redisUrl provided → BullMQ worker on Redis (production / docker compose);
 *  - otherwise → in-memory queue with concurrency limiting (tests, zero-infra
 *    mode). Tests MUST NOT require Redis: they either omit redisUrl or inject
 *    their own memory queue via registerSocketHandlers' opts / deps overrides.
 *
 * server.ts never calls this directly today: the queue lives inside
 * registerSocketHandlers because the owner-only emit path (item:failed) needs
 * the ws layer's private playerSockets map (documented there). The factory is
 * still the flavor selector both paths share.
 */

import { createBullMqImageQueue } from "./bullmq-queue";
import { createMemoryImageQueue, type ImageJob, type ImageQueue } from "./queue";

export interface CreatedImageQueue extends ImageQueue {
  kind: "memory" | "bullmq";
  close(): Promise<void>;
  /** Memory-only extras (absent on the BullMQ flavor). */
  size?(): number;
  inFlight?(): number;
  drained?(): Promise<void>;
}

/** BullMQ when a redisUrl is given, memory otherwise. */
export function createImageQueue(
  redisUrl: string | undefined,
  handler: (job: ImageJob) => Promise<void> = async () => {},
): CreatedImageQueue {
  if (redisUrl) {
    return {
      ...createBullMqImageQueue(redisUrl, handler),
      kind: "bullmq" as const,
    };
  }
  const memory = createMemoryImageQueue(handler);
  return {
    enqueue: memory.enqueue,
    size: memory.size,
    inFlight: memory.inFlight,
    drained: memory.drained,
    kind: "memory" as const,
    close: async () => {}, // nothing to release — pure in-memory
  };
}