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

/** An https URL on one host that is only a path: no port, credentials, query or fragment. */
function plainPath(value: string, hostnames: readonly string[]): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      hostnames.includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === `${url.origin}${url.pathname}`
      ? url
      : null;
  } catch {
    return null;
  }
}

/** A package page on npmjs.com; the name is checked like the coordinator checks package names. */
export function externalPackageUrl(value: string): string | null {
  const url = plainPath(value, ["www.npmjs.com"]);
  return url &&
    /^\/package\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(url.pathname) &&
    url.pathname.length <= "/package/".length + 214
    ? url.href
    : null;
}

/** A GitHub (owner/repo) or GitLab (group[/subgroup]/project) repository page. */
export function externalRepositoryUrl(value: string): string | null {
  const url = plainPath(value, ["github.com", "gitlab.com"]);
  // The URL parser has already resolved any "." and ".." segments. Every segment starts with a
  // letter or digit, which leaves out GitLab's "/-/" routes and dot or underscore pages.
  return url &&
    /^\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(url.pathname) &&
    (url.hostname !== "github.com" || url.pathname.split("/").length === 3)
    ? url.href
    : null;
}

export function externalApplicationUrl(value: string): string | null {
  const advisory = externalAdvisoryUrl(value);
  if (advisory) return advisory;
  const destination = externalPackageUrl(value) ?? externalRepositoryUrl(value);
  if (destination) return destination;
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
