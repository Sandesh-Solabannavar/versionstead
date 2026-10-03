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

export function externalApplicationUrl(value: string): string | null {
  const advisory = externalAdvisoryUrl(value);
  if (advisory) return advisory;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/Sandesh-Solabannavar\/versionstead\/releases\/tag\/[A-Za-z0-9._-]{1,100}$/.test(
        url.pathname,
      )
      ? url.href
      : null;
  } catch {
    return null;
  }
}
