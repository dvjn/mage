/// <reference lib="dom" />
import { expect, type Locator, type Page, test } from "@playwright/test";

// The layout rules that only a rendered page shows: controls in a row share a height, a menu's
// search box, labels, rows and highlights share one inset, a suggestion list never resizes its
// dialog, and no menu clips a label. Boxes are compared to within a pixel.

const TOLERANCE = 1;

// Sign-ups are rate limited per client address; each journey counts as its own client.
let client = 200;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.2.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function signUp(page: Page, name: string) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

// A box once it has stopped moving: dialogs and menus animate in.
async function box(locator: Locator) {
  let last = await locator.boundingBox();
  for (let tries = 0; tries < 20; tries++) {
    await locator.page().waitForTimeout(50);
    const next = await locator.boundingBox();
    if (next && last && JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  if (!last) throw new Error("Not rendered");
  return last;
}

function near(actual: number, expected: number, what: string) {
  expect(Math.abs(actual - expected), `${what}: ${actual} against ${expected}`).toBeLessThanOrEqual(
    TOLERANCE,
  );
}

// Controls in a row share one height.
async function sameHeight(row: Locator, rule: string) {
  // Skip what takes no room, such as an anchor or a hidden input.
  const children = row.locator("> *:not([aria-hidden])");
  // The row is there once the dialog that holds it has loaded.
  await expect
    .poll(async () => children.count(), { message: `${rule}: a row of controls` })
    .toBeGreaterThan(1);
  const heights = await children.evaluateAll((all) =>
    all.map((one) => one.getBoundingClientRect().height).filter((height) => height > 4),
  );
  for (const height of heights) near(height, heights[0]!, `${rule}: heights ${heights.join(", ")}`);
}

// Waits for the element's animations, and those inside it, to finish, so what is measured next is
// where it rests.
async function settled(locator: Locator) {
  await locator.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .map(async (animation) => animation.finished.catch(() => {})),
    ),
  );
}

// One inset: the search box and the highlights start at the menu's edge, and the labels and what
// the rows hold start at the same x. Measured in one frame once the menu rests.
async function oneInset(menu: Locator, rule: string) {
  await settled(menu);
  const found = await menu.evaluate((element) => {
    const left = (one: Element) => one.getBoundingClientRect().left;
    // Where an element's content starts: its box plus its own padding.
    const contentLeft = (one: Element) =>
      left(one) + Number.parseFloat(getComputedStyle(one).paddingLeft);
    const items = [...element.querySelectorAll("[data-slot=dropdown-menu-item]")];
    const input = element.querySelector("[data-slot=input-group]")!;
    const label = element.querySelector("[data-slot=dropdown-menu-label]")!;
    const inside = element.getBoundingClientRect();
    return {
      input: left(input),
      item: left(items[0]!),
      label: left(label),
      labelText: contentLeft(label),
      itemContent: contentLeft(items[0]!),
      menu: { left: inside.left, right: inside.right },
      rows: items.map((item) => item.getBoundingClientRect()).map((r) => [r.left, r.right]),
    };
  });
  near(found.item, found.input, `${rule}: row highlight against the search box`);
  near(found.label, found.input, `${rule}: label box against the search box`);
  near(found.labelText, found.itemContent, `${rule}: label text against row content`);
  for (const [rowLeft, rowRight] of found.rows) {
    expect(rowLeft, `${rule}: a highlight starts inside the menu`).toBeGreaterThanOrEqual(
      found.menu.left,
    );
    expect(rowRight, `${rule}: a highlight ends inside the menu`).toBeLessThanOrEqual(
      found.menu.right + TOLERANCE,
    );
  }
}

// Menus are wide enough that no label is clipped.
async function nothingClipped(menu: Locator, rule: string) {
  const clipped = await menu
    .locator("[role=menuitem]")
    .evaluateAll((items) =>
      items.flatMap((item) =>
        [item, ...item.querySelectorAll("*")]
          .filter(
            (one) =>
              !one.matches(".sr-only") &&
              one.scrollWidth > one.clientWidth + 1 &&
              one.clientWidth > 0,
          )
          .map((one) => one.textContent?.trim() ?? ""),
      ),
    );
  expect(clipped, `${rule}: clipped labels`).toEqual([]);
}

test("a thread's share dialog lines its controls up, and its menus share one inset and clip nothing", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // The share dialog's rows of controls.
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this thread" });
  const rule = "Layout: controls in a row share one height";
  await sameHeight(
    dialog
      .getByPlaceholder("Add people")
      .locator("xpath=ancestor::div[normalize-space(@class)='flex gap-2'][1]"),
    `${rule} (add row)`,
  );
  await sameHeight(
    dialog.locator('section[aria-label="Invite with a link"] > div').first(),
    `${rule} (invite row)`,
  );
  await page.keyboard.press("Escape");

  // The thread's More menu.
  await page.getByRole("button", { name: "More", exact: true }).click();
  const more = page.getByRole("menu");
  await expect(more).toBeVisible();
  await nothingClipped(more, "Antipattern: menus too narrow for their labels (More)");
  await settled(more);
  const rows = await more
    .locator("[data-slot=dropdown-menu-item]")
    .evaluateAll((all) => all.map((one) => one.getBoundingClientRect().x));
  for (const x of rows) near(x, rows[0]!, "Layout: one inset (More menu rows)");
  await page.keyboard.press("Escape");
  await expect(more).toBeHidden();

  // The space switcher.
  await page.getByRole("button", { name: "Switch space" }).click();
  const switcher = page.getByRole("dialog", { name: "Switch space" });
  await expect(switcher.getByRole("menuitem", { name: "Organization settings" })).toBeVisible();
  await oneInset(switcher, "Layout: one inset (space switcher)");
  await nothingClipped(switcher, "Antipattern: menus too narrow for their labels (space switcher)");
});

test("adding people never resizes its dialog, and what it lists stays within the input", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Analytical Engines");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL("/org/general");
  await page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link", { name: "People" })
    .click();
  await page.getByRole("button", { name: "Add people" }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByLabel(/^Name(, email or group| or email)$/);

  // Opening the suggestions and typing leaves the dialog as tall as it was.
  const before = (await box(dialog)).height;
  await field.fill("Ada");
  await expect(page.getByRole("listbox")).toBeVisible();
  near(
    (await box(dialog)).height,
    before,
    "Layout: suggestions open in a popover; the dialog never resizes",
  );
  await field.fill("");

  // What is listed below the box is no wider than the box, and its controls share a height.
  await field.fill(`grace-${crypto.randomUUID()}@example.com`);
  const adding = dialog.getByRole("list", { name: "Adding" });
  await expect(adding).toBeVisible();
  // The field is the box and the controls beside it.
  const input = await box(
    field.locator("xpath=ancestor::div[normalize-space(@class)='flex gap-2'][1]"),
  );
  const row = await box(adding.locator("> li").first());
  expect(row.x, "Layout: a row's highlight stays within the input (left)").toBeGreaterThanOrEqual(
    input.x - TOLERANCE,
  );
  expect(
    row.x + row.width,
    "Layout: a row's highlight stays within the input (right)",
  ).toBeLessThanOrEqual(input.x + input.width + TOLERANCE);
});
