import { expect, it } from "vitest";
import { runBatch } from "@/lib/batch-queue";
it.each([10, 25, 100])(
  "processes %i unique items within concurrency and keeps going after an error",
  async (count) => {
    let active = 0,
      maximum = 0;
    const seen: number[] = [];
    const result = await runBatch(
      Array.from({ length: count }, (_, i) => i),
      3,
      async (i) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((r) => setTimeout(r, 1));
        seen.push(i);
        active--;
        if (i === 5) throw new Error("Simulated item failure");
      },
    );
    expect(seen).toHaveLength(count);
    expect(new Set(seen).size).toBe(count);
    expect(maximum).toBe(3);
    expect(result.errors).toHaveLength(1);
  },
);
it("pause stops new work while active items finish", async () => {
  let paused = false;
  const seen: number[] = [];
  const result = await runBatch(
    [1, 2, 3, 4, 5],
    2,
    async (i) => {
      await Promise.resolve();
      seen.push(i);
      paused = true;
    },
    { paused: () => paused },
  );
  expect(seen).toEqual([1, 2]);
  expect(result.completed).toBe(2);
});
