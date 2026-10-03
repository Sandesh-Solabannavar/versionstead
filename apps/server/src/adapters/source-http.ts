import { InputError } from "./projects.ts";

export async function readSource(
  url: string,
  options: {
    headers?: Record<string, string>;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    limit?: number;
    missing?: boolean;
  } = {},
): Promise<string | null> {
  const response = await (options.fetcher ?? fetch)(url, {
    ...(options.headers ? { headers: options.headers } : {}),
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(12000),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (options.missing && response.status === 404) return null;
    throw new InputError(
      response.status === 401 || response.status === 403
        ? "The provider rejected access. Check the connection's read permissions or rate limit."
        : response.status === 429
          ? "The provider rate limit was reached. Retry later."
          : "The remote source is unavailable.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > (options.limit ?? 16 * 1024 * 1024))
        throw new InputError("The remote response exceeds its supported size.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}
