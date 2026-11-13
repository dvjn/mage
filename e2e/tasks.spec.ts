import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 540;
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

async function addTasks(page: Page, ...titles: string[]) {
  await write(
    page,
    `^tool thread.add_tasks ${JSON.stringify({ tasks: titles.map((title) => ({ title })) })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const strip = page
    .getByRole("toolbar", { name: "Context" })
    .getByRole("button", { name: "Tasks" });
  await strip.click();
  return {
    strip,
    card: page.getByRole("region", { name: "Tasks" }),
    list: page.getByTestId("task-list"),
  };
}

test("tasks the agent adds show in a list above the composer, and a person cycles a status", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    `^tool thread.add_tasks ${JSON.stringify({ tasks: [{ title: "Read the spec" }, { title: "Write it" }] })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const tasks = page
    .getByRole("toolbar", { name: "Context" })
    .getByRole("button", { name: "Tasks" });
  await expect(tasks).toContainText("0/2");
  // The card starts closed.
  const list = page.getByTestId("task-list");
  await expect(list).toHaveCount(0);
  await tasks.click();
  const titles = list.getByRole("textbox", { name: "Task title" });
  await expect(titles.first()).toHaveValue("Read the spec");
  // todo, then doing, then done, and back to todo.
  await list.getByRole("button", { name: "Status: todo. Set to doing" }).first().click();
  await expect(list.getByRole("button", { name: "Status: doing. Set to done" })).toHaveCount(1);
  await expect(tasks).toContainText("0/2");
  await list.getByRole("button", { name: "Status: doing. Set to done" }).click();
  await expect(tasks).toContainText("1/2");
  await expect(list.getByRole("button", { name: "Status: done. Set to todo" })).toHaveCount(1);
  // What the agent adds is the agent's to do.
  await expect(list.getByRole("combobox", { name: "Assignee: Agent" })).toHaveCount(2);
  await list.getByRole("button", { name: "Status: done. Set to todo" }).click();
  await expect(tasks).toContainText("0/2");
});

test("a person renames a task in place: Enter saves, Esc takes it back", async ({ page }) => {
  await signUp(page);
  const { list } = await addTasks(page, "Read the spec");
  const title = list.getByRole("textbox", { name: "Task title" });
  await title.fill("Skim the spec");
  await title.press("Escape");
  await expect(title).toHaveValue("Read the spec");
  await title.fill("Skim the spec");
  await title.press("Enter");
  await expect(title).toHaveValue("Skim the spec");
  await page.reload();
  await page
    .getByRole("toolbar", { name: "Context" })
    .getByRole("button", { name: "Tasks" })
    .click();
  await expect(
    page.getByTestId("task-list").getByRole("textbox", { name: "Task title" }),
  ).toHaveValue("Skim the spec");
});

test("a person gives a task to the agent or themselves from a searchable list", async ({
  page,
}) => {
  await signUp(page);
  const { list } = await addTasks(page, "Read the spec");
  // A task the agent adds is the agent's.
  const picker = list.getByRole("combobox", { name: "Assignee: Agent" });
  await picker.click();
  await page.getByRole("combobox", { name: "Search assignees" }).fill("lovel");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: "Ada Lovelace" }).click();
  await expect(list.getByRole("combobox", { name: "Assignee: Ada Lovelace" })).toBeVisible();
  await list.getByRole("combobox", { name: "Assignee: Ada Lovelace" }).click();
  await page.getByRole("combobox", { name: "Search assignees" }).fill("zzz");
  await expect(page.getByText("No matches")).toBeVisible();
  await page.getByRole("combobox", { name: "Search assignees" }).fill("");
  // Nobody is not a choice.
  await expect(page.getByRole("option", { name: "Unassigned" })).toHaveCount(0);
  await page.getByRole("option", { name: "Agent" }).click();
  await expect(list.getByRole("combobox", { name: "Assignee: Agent" })).toBeVisible();
});

test("a person removes a task", async ({ page }) => {
  await signUp(page);
  const { list, strip } = await addTasks(page, "Read the spec", "Write it");
  await list.getByRole("button", { name: "Remove Read the spec" }).click();
  await expect(list.getByRole("textbox", { name: "Task title" })).toHaveCount(1);
  await expect(list.getByRole("textbox", { name: "Task title" })).toHaveValue("Write it");
  await expect(strip).toContainText("0/1");
});

test("a person archives the done tasks and views the archived ones, read-only", async ({
  page,
}) => {
  await signUp(page);
  const { list, card, strip } = await addTasks(page, "Read the spec", "Write it");
  // With nothing done there is nothing to archive.
  await expect(card.getByRole("button", { name: "Archive done" })).toHaveCount(0);
  await list.getByRole("button", { name: "Status: todo. Set to doing" }).first().click();
  await list.getByRole("button", { name: "Status: doing. Set to done" }).click();
  await expect(strip).toContainText("1/2");
  await card.getByRole("button", { name: "Archive done" }).click();
  await expect(list.getByRole("textbox", { name: "Task title" })).toHaveCount(1);
  await expect(list.getByRole("textbox", { name: "Task title" })).toHaveValue("Write it");
  await expect(strip).toContainText("0/1");

  const archived = card.getByRole("button", { name: "Archived" });
  await expect(archived).toHaveAttribute("aria-pressed", "false");
  await archived.click();
  await expect(archived).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByText("Read the spec")).toBeVisible();
  await expect(list.getByRole("textbox", { name: "Task title" })).toHaveCount(0);
  await expect(list.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Archive done" })).toHaveCount(0);
  await archived.click();
  await expect(list.getByRole("textbox", { name: "Task title" })).toHaveValue("Write it");
});

test("a person adds tasks from the card's header", async ({ page }) => {
  await signUp(page);
  const { card, list, strip } = await addTasks(page, "Read the spec");
  // Nothing at the bottom of the list; the header button opens a row at its top.
  await expect(list.getByRole("textbox", { name: "Add task" })).toHaveCount(0);
  await card.getByRole("button", { name: "Add task" }).click();
  const added = list.getByRole("textbox", { name: "New task" });
  await expect(added).toBeFocused();
  await added.fill("Write it");
  await added.press("Enter");
  // It stays open for the next one, and the new task joins the end.
  await expect(added).toHaveValue("");
  await expect(added).toBeFocused();
  await added.fill("Ship it");
  await added.press("Enter");
  await expect(strip).toContainText("0/3");
  const titles = list.getByRole("textbox", { name: "Task title" });
  await expect(titles).toHaveCount(3);
  await expect(titles.nth(1)).toHaveValue("Write it");
  await expect(titles.nth(2)).toHaveValue("Ship it");
  // Esc closes it.
  await added.press("Escape");
  await expect(added).toHaveCount(0);
  await expect(card).toBeVisible();
  // Empty, leaving it closes it too.
  await card.getByRole("button", { name: "Add task" }).click();
  await list.getByRole("textbox", { name: "New task" }).blur();
  await expect(list.getByRole("textbox", { name: "New task" })).toHaveCount(0);
  // Archived tasks are read-only, with no way to add.
  await card.getByRole("button", { name: "Archived" }).click();
  await expect(card.getByRole("button", { name: "Add task" })).toHaveCount(0);
});

test("a task a person adds is theirs, and a long list is paged", async ({ page }) => {
  await signUp(page);
  const { card, list } = await addTasks(page, "One", "Two", "Three", "Four", "Five", "Six");
  await expect(card.getByTestId("pager")).toContainText("1–5 of 6");
  await expect(list.getByRole("textbox", { name: "Task title" })).toHaveCount(5);
  await card.getByRole("button", { name: "Add task" }).click();
  const added = list.getByRole("textbox", { name: "New task" });
  await added.fill("Seven");
  await added.press("Enter");
  // The page with the new task shows.
  await expect(card.getByTestId("pager")).toContainText("6–7 of 7");
  await expect(list.getByRole("textbox", { name: "Task title" }).last()).toHaveValue("Seven");
  await expect(list.getByRole("combobox", { name: "Assignee: Ada Lovelace" })).toBeVisible();
});
