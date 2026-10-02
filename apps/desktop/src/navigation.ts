export function externalAdvisoryUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "osv.dev" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === `${url.origin}${url.pathname}` &&
      /^\/vulnerability\/[A-Za-z0-9_-]{1,150}$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
