import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 560;
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

test("a schedule the agent sets is a tool row and a card in the tray, where a person pauses and deletes it", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    `^tool triggers.schedule ${JSON.stringify({ name: "Digest", cron: "0 9 * * 1-5", timezone: "UTC", prompt: "Write it" })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const call = page.getByRole("button", { name: /^Triggers › Schedule · Ran/ });
  await expect(call).toBeVisible();
  await call.click();
  await expect(call).toHaveAttribute("aria-expanded", "true");
  const strip = page.getByRole("toolbar", { name: "Context" });
  await strip.getByRole("button", { name: "Schedules" }).click();
  const card = page.getByTestId("tray-card").filter({ hasText: "Digest" });
  await expect(card).toContainText("Next");
  await expect(card).toContainText("Weekdays at 09:00");
  await expect(card.getByRole("button", { name: "More for Digest" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Go to message" })).toBeVisible();
  const replies = page.getByRole("article", { name: "Message from Agent" });
  await expect(replies.last()).toBeVisible();
  const answered = await replies.count();
  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card).toContainText("Paused");
  // A person's change is told to the agent in the transcript, and does not start it.
  await expect(
    page.getByRole("article", { name: "Notification" }).filter({
      hasText: /Digest\s*Paused/,
    }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(replies).toHaveCount(answered);
  await card.getByRole("button", { name: "Resume" }).click();
  await expect(card).toContainText("Next");
  await card.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(strip).toBeHidden();
  // The transcript keeps its row as the record, no longer linking to the tray.
  await expect(call).toBeVisible();
});

test("a kind of the tray opens inline on a phone, capped at half the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signUp(page);
  await write(
    page,
    `^tool triggers.schedule ${JSON.stringify({ name: "Digest", cron: "0 9 * * 1-5", timezone: "UTC", prompt: "Write it" })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await page
    .getByRole("toolbar", { name: "Context" })
    .getByRole("button", { name: "Schedules" })
    .click();
  const panel = page.getByRole("region", { name: "Schedules" });
  await expect(panel.getByTestId("tray-card")).toContainText("Digest");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The panel shares the surface with the input and stays within half the viewport.
  const [box, input] = await Promise.all([
    panel.boundingBox(),
    page.getByRole("textbox", { name: "Message", exact: true }).boundingBox(),
  ]);
  expect(box!.height).toBeLessThanOrEqual(400);
  expect(box!.y + box!.height).toBeLessThanOrEqual(input!.y);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("a wake-up timer goes off and tells the thread", async ({ page }) => {
  await signUp(page);
  await write(
    page,
    `^tool triggers.wake_at ${JSON.stringify({ in_seconds: 1, note: "Look again" })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  // The two servers of these journeys share a database, so the other may be the one that fires it;
  // its news reaches this page on a reload.
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole("article", { name: "Notification" }).getByText("Wake-up"),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // The agent reads the note and answers it.
  await expect(page.getByRole("article", { name: "Message from Agent" }).last()).toContainText(
    "I have read 2 messages",
  );
});

test("tasks and a schedule share the strip, one kind open at a time, closed by Escape", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    `^tool triggers.schedule ${JSON.stringify({ name: "Digest", cron: "0 9 * * 1-5", timezone: "UTC", prompt: "Write it" })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await write(
    page,
    `^tool thread.add_tasks ${JSON.stringify({ tasks: [{ title: "One" }, { title: "Two" }] })}`,
  );
  const strip = page.getByRole("toolbar", { name: "Context" });
  await expect(strip.getByRole("button", { name: "Tasks" })).toContainText("0/2");
  // The strip is a row above the composer; the last message stays clear of it.
  const last = page.getByText("^tool thread.add_tasks").last();
  const [message, bar] = await Promise.all([last.boundingBox(), strip.boundingBox()]);
  expect(message!.y + message!.height).toBeLessThanOrEqual(bar!.y);
  // Opening and closing a kind leaves what is typed in the composer.
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("a draft");
  const resting = await strip.boundingBox();
  await strip.getByRole("button", { name: "Tasks" }).click();
  await expect(
    page.getByTestId("task-list").getByRole("textbox", { name: "Task title" }).nth(1),
  ).toHaveValue("Two");
  // The panel grows upward; the strip stays where it was, above the input.
  expect((await strip.boundingBox())!.y).toBe(resting!.y);
  await strip.getByRole("button", { name: "Schedules" }).click();
  await expect(page.getByTestId("task-list")).toHaveCount(0);
  await expect(page.getByTestId("tray-card")).toContainText("Digest");
  expect((await strip.boundingBox())!.y).toBe(resting!.y);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tray-cards")).toHaveCount(0);
  // A click elsewhere closes it.
  await strip.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByTestId("task-list")).toBeVisible();
  await page.getByText("^tool thread.add_tasks").last().click();
  await expect(page.getByTestId("tray-cards")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("a draft");
});
