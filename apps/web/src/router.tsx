import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { About, Coverage, Overview } from "./pages";
import { ThemeSelect } from "./theme";

function Shell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="Versionstead home">
          <span className="brand-mark" aria-hidden="true">
            v.
          </span>
          <span>Versionstead</span>
        </Link>
        <p className="workspace-label">Personal workspace</p>
        <nav aria-label="Main navigation">
          <Link to="/" activeOptions={{ exact: true }}>
            Overview
          </Link>
          <Link to="/coverage">Coverage</Link>
          <Link to="/about">About</Link>
        </nav>
        <div className="sidebar-footer">
          <p className="muted">A home for your software.</p>
          <ThemeSelect />
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>Software health</span>
          <span className="tag">Foundation</span>
        </header>
        <main id="content" tabIndex={-1} className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <section>
      <h1>Page not found</h1>
      <p className="muted">This page does not exist in your workspace.</p>
      <Link to="/" className="text-link">
        Return to overview
      </Link>
    </section>
  ),
});
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Overview,
});
const coverageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/coverage",
  component: Coverage,
});
const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: About,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([overviewRoute, coverageRoute, aboutRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
