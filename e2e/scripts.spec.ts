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

test("a script shows its code and output first, and its calls grouped by tool behind one line", async ({
  page,
}) => {
  await signUp(page);
  const code = [
    'info = await call_tool("thread__info", {})',
    'again = await call_tool("thread__info", {})',
    'print("people", len(info["people"]))',
    'info["title"]',
  ].join("\n");
  await write(page, `^tool scripts.run ${JSON.stringify({ code })}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // The script is the agent's one call; its calls are counted on it, not shown beside it.
  const script = transcript(page).getByRole("button", {
    name: /^Scripts › Run script · Ran · 2 calls$/,
  });
  await expect(script).toBeVisible();
  await expect(transcript(page).getByRole("button", { name: /Details · Ran/ })).toHaveCount(0);

  // Its code shows as code, and what it printed as its output.
  await script.click();
  const input = transcript(page).getByRole("region", { name: "Input" }).first();
  await expect(input.locator("pre")).toContainText('await call_tool("thread__info", {})');
  await expect(transcript(page).getByRole("region", { name: "Output" }).first()).toContainText(
    "people 1",
  );

  // Its calls open grouped by tool, and each on its own input and output.
  await transcript(page).getByRole("button", { name: "2 tool calls" }).click();
  const details = transcript(page).getByRole("button", { name: "Thread › Details · ×2" });
  await details.click();
  const calls = transcript(page).getByRole("button", { name: /^Thread › Details · Ran/ });
  await expect(calls).toHaveCount(2);
  await calls.first().click();
  await expect(transcript(page).getByRole("region", { name: "Output" })).toHaveCount(2);
});

test("a learned skill's script runs by its file, showing the file's name over its code", async ({
  page,
}) => {
  await signUp(page);
  const save = `^tool space.save_skill ${JSON.stringify({
    name: "doubler",
    description: "Double a number",
    instructions: "Run double.py.",
    files: [{ path: "double.py", text: "n * 2" }],
  })}`;
  await write(page, `/reflect\n${save}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toHaveCount(0);

  const run = { file: "doubler/double.py", inputs: { n: 21 } };
  await write(page, `^tool scripts.run ${JSON.stringify(run)}`);
  const script = transcript(page).getByRole("button", { name: /^Scripts › Run script · Ran/ });
  await script.click();
  const input = transcript(page).getByRole("region", { name: "Input" }).first();
  await expect(input).toContainText("doubler/double.py");
  await expect(input.locator("pre")).toContainText("n * 2");
  await expect(transcript(page).getByRole("region", { name: "Output" }).first()).toContainText(
    "42",
  );
});

test("a script pauses at a call that needs approval, and goes on once it is allowed from the card", async ({
  page,
}) => {
  await signUp(page);
  const code = [
    'print("checked the deploy")',
    'await call_tool("webhooks__add", {"name": "Deploys", "note": "Check the deploy"})',
    '"added"',
  ].join("\n");
  await write(page, `^tool scripts.run ${JSON.stringify({ code })}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await expect(card).toContainText("Run script");
  await expect(card.getByRole("link", { name: "Show caller" })).toBeVisible();
  // The waiting call shows without opening anything, once, among the script's calls.
  await expect(
    transcript(page).getByRole("button", {
      name: /^Webhooks › Add webhook · Waiting for approval/,
    }),
  ).toHaveCount(1);
  // What it printed before it paused shows, read afresh too.
  const soFar = transcript(page).getByRole("region", { name: "Output so far" });
  await expect(soFar).toContainText("checked the deploy");
  await page.reload();
  await expect(soFar).toContainText("checked the deploy");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    transcript(page).getByRole("button", { name: /^Scripts › Run script · Ran · 1 call$/ }),
  ).toBeVisible();
  await expect(transcript(page)).toContainText('"result":"added"');
});
