export async function processFiles<T>(
  files: File[],
  limit: number,
  process: (file: File) => Promise<T>,
): Promise<{ values: T[]; errors: string[] }> {
  const selected = files.slice(0, Math.max(0, limit));
  const results: (T | undefined)[] = new Array(selected.length);
  const errors: string[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, selected.length) }, async () => {
      while (cursor < selected.length) {
        const i = cursor++;
        try {
          results[i] = await process(selected[i]);
        } catch (e) {
          errors.push(`${selected[i].name}: ${(e as Error).message}`);
        }
      }
    }),
  );
  if (files.length > selected.length)
    errors.push(
      `${files.length - selected.length} photos exceed the batch limit and were not added.`,
    );
  return { values: results.filter((v): v is T => v !== undefined), errors };
}
