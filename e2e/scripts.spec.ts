import { expect, type Page, test } from "@playwright/test";

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

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

test("a script's calls show under it as calls of their own, and its code as Python", async ({
  page,
}) => {
  await signUp(page);
  const code =
    'info = await call_tool("thread__info", {})\nprint("people", len(info["people"]))\ninfo["title"]';
  await write(page, `^tool scripts.run ${JSON.stringify({ code })}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // The script and the call it made fold into one run of calls.
  const group = transcript(page).getByRole("button", { name: /^2 tool calls/ });
  await expect(group).toBeVisible();
  await group.click();
  const script = transcript(page).getByRole("button", { name: /Scripts › Run script · Ran/ });
  const inner = transcript(page).getByRole("button", {
    name: /Run script › Thread › Details · Ran/,
  });
  await expect(script).toBeVisible();
  await expect(inner).toBeVisible();

  // The script's code shows as code.
  await script.click();
  const input = transcript(page).getByRole("region", { name: "Input" }).first();
  await expect(input.locator("pre")).toContainText('await call_tool("thread__info", {})');
});

test("a script pauses at a call that needs approval, and goes on once it is allowed from the card", async ({
  page,
}) => {
  await signUp(page);
  const code = [
    'await call_tool("webhooks__add", {"name": "Deploys", "note": "Check the deploy"})',
    '"added"',
  ].join("\n");
  await write(page, `^tool scripts.run ${JSON.stringify({ code })}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await expect(card).toContainText("Run script");
  await expect(card.getByRole("link", { name: "Show caller" })).toBeVisible();
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    transcript(page).getByRole("button", { name: /^2 tool calls · Scripts, Webhooks$/ }),
  ).toBeVisible();
  await expect(transcript(page)).toContainText('"result":"added"');
});
