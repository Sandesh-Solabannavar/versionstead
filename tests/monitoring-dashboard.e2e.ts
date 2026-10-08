import { test } from "@e2e-dev/web";
import { expect, secrets } from "e2e";

// Authenticate and wait for the coordinator connection to be established.
async function connect(
  app: Parameters<Parameters<typeof test>[1]>[0]["app"],
  screen: Parameters<Parameters<typeof test>[1]>[0]["screen"],
) {
  await app.open("/");
  await expect(screen.getByPlaceholder("Local access code")).toBeVisible();
  await screen.getByPlaceholder("Local access code").fill(secrets.get("accessToken"));
  await screen.getByRole("button", { name: "Connect" }).click();
  await expect(screen.getByTestId("connection-state")).toHaveAttribute("data-state", "online");
}

/**
 * Most important user flow: the owner connects to the local coordinator and
 * reaches the monitoring dashboard.
 */
test("owner connects and sees the monitoring dashboard", async ({
  app,
  agent,
  screen,
  browser,
}) => {
  await connect(app, screen);

  // Agent: confirm the main layout and navigation have loaded.
  await agent.assert(
    'the monitoring dashboard is showing with a sidebar containing "Needs attention", "This PC", and "Projects" navigation links',
  );

  await expect(browser).toHaveURL("/");
});

test("sidebar navigation links reach each section", async ({ app, screen, browser }) => {
  await connect(app, screen);

  await screen.getByRole("link", { name: "This PC", exact: false }).click();
  await expect(browser).toHaveURL("/pc");
  await expect(screen.getByRole("heading", { name: "This PC", level: 1 })).toBeVisible();

  await screen.getByRole("link", { name: "Projects", exact: false }).click();
  await expect(browser).toHaveURL("/projects");
  await expect(screen.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();

  await screen.getByRole("link", { name: "Background service", exact: false }).click();
  await expect(browser).toHaveURL("/service");
  await expect(screen.getByRole("heading", { name: "Background service", level: 1 })).toBeVisible();

  await screen.getByRole("link", { name: "Needs attention", exact: false }).click();
  await expect(browser).toHaveURL("/");
  await expect(screen.getByRole("heading", { name: "Needs attention", level: 1 })).toBeVisible();
});

test("scanning this PC populates the installation list", async ({
  app,
  agent,
  screen,
  browser,
}) => {
  await connect(app, screen);

  await screen.getByRole("link", { name: "This PC" }).click();
  await expect(browser).toHaveURL("/pc");

  // Two "Scan now" buttons exist when the filter shows no results — click the first.
  await screen.getByRole("button", { name: "Scan now" }).first().click();

  // Wait for the scan to finish and results to appear on screen.
  await agent.waitFor(
    "the scan has finished and the page shows either a list of installed global tools with version information or a message indicating there are no global tools found",
  );

  await agent.assert(
    "the This PC page shows scan results — either a table of globally installed packages or a clear empty-state message",
  );
});
