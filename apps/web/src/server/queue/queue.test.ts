/**
 * Queue tests (build-phase step 2) — memory queue concurrency/FIFO semantics
 * and the createImageQueue flavor selection. NO redis dependency: the BullMQ
 * flavor is never instantiated here (it would open a real connection).
 */

import { describe, expect, it } from "vitest";

import { createImageQueue } from "./create-image-queue";
import { createMemoryImageQueue, type ImageJob } from "./queue";

const job = (n: number): ImageJob => ({
  itemId: `item-${n}`,
  gameId: "g1",
  teamId: "t1",
  playerId: "p1",
  round: 1,
  prompt: `prompt ${n}`,
  subject: `subject ${n}`,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("memory image queue", () => {
  it("respects the concurrency cap (3 handlers max for 10 jobs)", async () => {
    let peak = 0;
    let running = 0;
    const started: number[] = [];
    const queue = createMemoryImageQueue(
      async (j) => {
        running++;
        peak = Math.max(peak, running);
        started.push(Number(j.itemId.split("-")[1]));
        await sleep(15);
        running--;
      },
      { concurrency: 3 },
    );

    for (let i = 0; i < 10; i++) await queue.enqueue(job(i));
    await queue.drained();

    expect(peak).toBe(3); // cap respected (and reached — 10 jobs, 3 slots)
    expect(started).toHaveLength(10);
  });

  it("starts jobs strictly FIFO (concurrency 1)", async () => {
    const started: number[] = [];
    const queue = createMemoryImageQueue(
      async (j) => {
        started.push(Number(j.itemId.split("-")[1]));
        await sleep(5);
      },
      { concurrency: 1 },
    );
    for (let i = 0; i < 6; i++) await queue.enqueue(job(i));
    await queue.drained();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a throwing handler never blocks later jobs or the enqueue caller", async () => {
    const done: string[] = [];
    const queue = createMemoryImageQueue(async (j) => {
      if (j.itemId === "item-1") throw new Error("boom");
      done.push(j.itemId);
    });
    await expect(queue.enqueue(job(0))).resolves.toBeUndefined();
    await queue.enqueue(job(1));
    await queue.enqueue(job(2));
    await queue.drained();
    expect(done).toEqual(["item-0", "item-2"]);
  });

  it("size()/inFlight() track pending vs running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queue = createMemoryImageQueue(async () => {
      await gate;
    }, { concurrency: 1 });
    await queue.enqueue(job(0));
    await queue.enqueue(job(1));
    expect(queue.inFlight()).toBe(1);
    expect(queue.size()).toBe(1);
    release();
    await queue.drained();
    expect(queue.inFlight()).toBe(0);
    expect(queue.size()).toBe(0);
  });
});

describe("createImageQueue flavor selection", () => {
  it("no redisUrl → memory queue (tests never instantiate BullMQ)", async () => {
    const q = createImageQueue(undefined);
    expect(q.kind).toBe("memory");
    // And it works as a queue end-to-end with a handler.
    const seen: string[] = [];
    const mem = createImageQueue(undefined, async (j) => {
      seen.push(j.itemId);
    });
    await mem.enqueue(job(7));
    await (mem as unknown as { drained(): Promise<void> }).drained();
    expect(seen).toEqual(["item-7"]);
    await expect(q.close()).resolves.toBeUndefined();
  });
});