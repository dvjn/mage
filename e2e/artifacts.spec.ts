import { expect, type Page, test } from "@playwright/test";

import { artifactHost } from "./servers.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 520;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

function call(toolId: string, input: object) {
  return `/tool ${toolId} ${JSON.stringify(input)}`;
}

const PAGE = (heading: string) =>
  `<title>Sales chart</title><h1>${heading}</h1><p id="js"></p><script>document.getElementById("js").textContent = "script ran"</script>`;

test("the agent publishes a page, it opens from the artifact origin, an update reloads it, and public needs both settings", async ({
  page,
  browser,
}) => {
  await signUp(page);
  await write(
    page,
    call("artifact.publish", {
      html: PAGE("Sales v1"),
      description: "Sales by month",
      icon: "chart",
    }),
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = page.getByTestId("artifact-card");
  await expect(card).toContainText("Sales chart");
  await expect(card).toContainText("Sales by month");
  await expect(card).toContainText("v1");

  await card.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/artifacts\/[^/]+$/);
  const id = page.url().split("/").pop()!;
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("src", new RegExp(`^${artifactHost(id)}/_a/v/`));
  const content = page.frameLocator("iframe");
  await expect(content.getByRole("heading", { name: "Sales v1" })).toBeVisible();
  await expect(content.locator("#js")).toHaveText("script ran");

  // The app's session never reaches the artifact origin, nor does its API.
  const api = await page.request.get(`${artifactHost(id)}/api/v1/spaces`);
  expect(api.status()).toBe(404);
  const direct = await page.request.get(`${artifactHost(id)}/_a/p/${id}/`);
  expect(direct.status()).toBe(404);

  // An update from the thread reloads the page open elsewhere.
  const thread = await page.context().newPage();
  await page
    .getByRole("link", { name: /artifact\.publish/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const threadUrl = page.url();
  await page.goBack();
  await expect(content.getByRole("heading", { name: "Sales v1" })).toBeVisible();
  await thread.goto(threadUrl);
  await write(
    thread,
    call("artifact.update", { id, edits: [{ old: "Sales v1", new: "Sales v2" }], label: "Two" }),
  );
  await expect(content.getByRole("heading", { name: "Sales v2" })).toBeVisible();

  // Older versions open read-only, with a way back.
  await page.getByRole("button", { name: "Version history" }).click();
  await page.getByRole("menuitemradio", { name: /^Version 1/ }).click();
  await expect(content.getByRole("heading", { name: "Sales v1" })).toBeVisible();
  const older = page.getByRole("region", { name: "Older version" });
  await expect(older).toContainText("Version 1 of 2 · read-only");
  await older.getByRole("button", { name: "Back to latest" }).click();
  await expect(content.getByRole("heading", { name: "Sales v2" })).toBeVisible();
  await expect(older).toHaveCount(0);

  // Sharing widens to the org; public is not offered until the org allows it.
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share artifact" });
  await expect(dialog.getByRole("radio", { name: "Organization" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Public" })).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Organization" }).click();
  await expect(dialog.getByRole("radio", { name: "Organization" })).toBeChecked();
  await expect(dialog.getByRole("textbox", { name: "Link" })).toHaveValue(
    new RegExp(`/artifacts/${id}$`),
  );
  await page.keyboard.press("Escape");

  await page.goto("/org/general");
  await page.getByRole("switch", { name: "Allow public artifacts" }).click();
  await expect(page.getByRole("switch", { name: "Allow public artifacts" })).toBeChecked();
  await page.goto(`/artifacts/${id}`);
  await page.getByRole("button", { name: "Share" }).click();
  await dialog.getByRole("radio", { name: "Public" }).click();
  await expect(dialog.getByRole("radio", { name: "Public" })).toBeChecked();
  // The link to copy is the public one.
  await expect(dialog.getByRole("textbox", { name: "Link" })).toHaveValue(
    `${artifactHost(id)}/_a/p/${id}/`,
  );

  // A public page opens by id with no link and no sign-in, under its policy.
  const anonymous = await browser.newContext();
  const open = await anonymous.request.get(`${artifactHost(id)}/_a/p/${id}/`);
  expect(open.status()).toBe(200);
  expect(open.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(await open.text()).toContain("Sales v2");
  await anonymous.close();
});

test("each artifact opens from an origin of its own", async ({ page }) => {
  await signUp(page);
  for (const heading of ["First", "Second"]) {
    await write(
      page,
      call("artifact.publish", { html: PAGE(heading), description: heading, icon: "chart" }),
    );
    await expect(page).toHaveURL(/\/t\/[^/]+$/);
    await expect(page.getByTestId("artifact-card")).toHaveCount(heading === "First" ? 1 : 2);
  }
  const origins: string[] = [];
  for (const index of [0, 1]) {
    await page.getByTestId("artifact-card").nth(index).getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(/\/artifacts\/[^/]+$/);
    const id = page.url().split("/").pop()!;
    const src = await page.locator("iframe").getAttribute("src");
    expect(src!.startsWith(`${artifactHost(id)}/_a/v/`)).toBe(true);
    origins.push(new URL(src!).origin);
    await page.goBack();
  }
  expect(origins[0]).not.toBe(origins[1]);
});

test("a card shows under the reply, a reply can place one, and the header lists them", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    [
      call("artifact.publish", { html: PAGE("One"), description: "One", icon: "chart" }),
      call("artifact.publish", { html: PAGE("Two"), description: "Two", icon: "chart" }),
    ].join("\n"),
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // The turn's two calls fold into a closed group; each artifact's card shows after it.
  const cards = page.getByTestId("artifact-card");
  await expect(cards).toHaveCount(2);

  // The header button counts the thread's artifacts and lists them.
  const button = page.getByRole("button", { name: "Artifacts", exact: true });
  await expect(button).toContainText("2");
  await button.click();
  await expect(page.getByRole("link", { name: /Sales chart/ })).toHaveCount(2);
  await page.keyboard.press("Escape");

  // A reply places a card with Artifact(id), and it opens the viewer.
  await cards.first().getByRole("link", { name: "Open" }).click();
  const id = page.url().split("/").pop()!;
  await page.goBack();
  await write(
    page,
    `/say\nHere it is.\n\n\`\`\`ui\nroot = Stack([card, gone])\ncard = Artifact("${id}")\ngone = Artifact("missing")\n\`\`\``,
  );
  const reply = page.getByRole("article", { name: "Message from Agent" }).last();
  await expect(reply.getByTestId("artifact-card")).toContainText("Sales chart");
  await expect(reply.getByText("Artifact unavailable")).toBeVisible();
  await reply.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/artifacts/${id}$`));
});

test("the gallery groups the artifacts by when they changed, and a card opens the viewer", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    call("artifact.publish", {
      html: PAGE("Gallery"),
      description: "Shown in the gallery",
      icon: "chart",
    }),
  );
  await expect(page.getByTestId("artifact-card")).toHaveCount(1);

  await page.getByRole("link", { name: "Artifacts" }).click();
  await expect(page).toHaveURL(/\/artifacts$/);
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  const cards = page.getByTestId("artifact-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Sales chart");
  await expect(cards.first()).toContainText("Shown in the gallery");
  await expect(cards.first()).toContainText("v1");
  await expect(page.getByRole("combobox")).toHaveCount(0);

  await cards.first().getByRole("link", { name: "Sales chart" }).click();
  await expect(page).toHaveURL(/\/artifacts\/[^/]+$/);
  await expect(page.locator("iframe")).toBeVisible();
});

test("another thread in the space updates an artifact, the header lists what it used, and deleting names the threads", async ({
  page,
}) => {
  await signUp(page);
  const spaceUrl = page.url();
  await write(
    page,
    [
      call("artifact.publish", { html: PAGE("One"), description: "One", icon: "chart" }),
      call("artifact.publish", { html: PAGE("Two"), description: "Two", icon: "chart" }),
    ].join("\n"),
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const first = page.url();
  const cards = page.getByTestId("artifact-card");
  await expect(cards).toHaveCount(2);
  await cards.first().getByRole("link", { name: "Open" }).click();
  const id = page.url().split("/").pop()!;
  await page.goto(first);

  // A second thread updates the first thread's artifact.
  await page.goto(spaceUrl);
  await write(
    page,
    call("artifact.update", { id, edits: [{ old: "One", new: "Uno" }], label: "Renamed" }),
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  expect(page.url()).not.toBe(first);

  // This thread used one of the space's two artifacts.
  const button = page.getByRole("button", { name: "Artifacts", exact: true });
  await expect(button).toContainText("1");
  await button.click();
  const list = page.getByRole("link", { name: /Sales chart/ });
  await expect(list).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Each version names the thread that published it, and deleting lists the threads that used it.
  await page.goto(`/artifacts/${id}`);
  await page.getByRole("button", { name: "Version history" }).click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("removed for everyone");
  await expect(dialog.getByRole("link")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/artifacts$/);
  await expect(page.getByTestId("artifact-card")).toHaveCount(1);
});
