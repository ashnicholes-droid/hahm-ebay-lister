import { expect, it, vi, beforeEach } from "vitest";
vi.mock("@/lib/api-client", () => ({ apiPost: vi.fn() }));
import { apiPost } from "@/lib/api-client";
import {
  loadAccountOptions,
  clearAccountOptions,
} from "@/lib/account-options-client";
const value = { fulfillment: [], payment: [], returns: [], locations: [] };
beforeEach(() => {
  clearAccountOptions();
  vi.mocked(apiPost).mockReset();
});
it("100 simultaneous drafts share one policy request and cache the result", async () => {
  vi.mocked(apiPost).mockResolvedValue(
    new Response(JSON.stringify({ ok: true, options: value })),
  );
  await Promise.all(Array.from({ length: 100 }, () => loadAccountOptions()));
  await loadAccountOptions();
  expect(apiPost).toHaveBeenCalledTimes(1);
});
it("failed loads can retry and switching accounts invalidates stale in-flight responses", async () => {
  vi.mocked(apiPost).mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: false }), { status: 502 }),
  );
  await expect(loadAccountOptions()).rejects.toThrow();
  let finish!: (r: Response) => void;
  vi.mocked(apiPost).mockImplementationOnce(
    () => new Promise((r) => (finish = r)),
  );
  const old = loadAccountOptions();
  clearAccountOptions();
  finish(new Response(JSON.stringify({ ok: true, options: value })));
  await expect(old).rejects.toThrow("connection changed");
  vi.mocked(apiPost).mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true, options: value })),
  );
  await expect(loadAccountOptions()).resolves.toEqual(value);
});
