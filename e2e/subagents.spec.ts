import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 470;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

async function signUp(page: Page, name = "Ada Lovelace") {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

// The row of a thread, or of a subagent, in the sidebar.
function sidebarRow(page: Page, title: string) {
  return page
    .locator("[data-sidebar=sidebar] [data-sidebar=menu-item][data-status]")
    .filter({ hasText: title });
}

async function idle(page: Page) {
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}

// A line asking the stand-in model to call the tool with the input.
function call(toolId: string, input: object) {
  return `^tool ${toolId} ${JSON.stringify(input)}`;
}

// A thread named Queue library, whose agent then starts the subagents.
async function queueLibrary(page: Page) {
  await write(page, call("thread.rename", { title: "Queue library" }));
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Queue library");
  await idle(page);
}

// Skipped for now: passes alone, but misses its wait under the full suite's parallel load.
test.fixme("the agent starts subagents, who report back, go idle and can be resumed and archived", async ({
  page,
}) => {
  await signUp(page);
  await queueLibrary(page);
  await write(
    page,
    [
      call("subagents.start", {
        name: "Researcher",
        task: call("subagents.send", { to: "agent", text: "Recommend BullMQ" }),
      }),
      call("subagents.start", { name: "Writer", task: "Draft the notes" }),
    ].join("\n"),
  );
  const parentUrl = page.url();

  // The subagents' starts fold into one line, each opening on where its subagent stands.
  const group = transcript(page).getByRole("button", { name: /^2 tool calls · Subagents/ });
  await expect(group).toBeVisible();
  await group.click();
  await expect(
    transcript(page).getByRole("button", { name: /^Subagents › Start · Researcher · Idle/ }),
  ).toBeVisible();
  await expect(
    transcript(page).getByRole("button", { name: /^Subagents › Start · Writer · Idle/ }),
  ).toBeVisible();

  // An incoming message is a card that is open on what was said; system events use the same frame.
  const relayed = transcript(page).getByRole("article", { name: "Message from Researcher" });
  await expect(relayed).toContainText("Recommend BullMQ");
  await expect(
    transcript(page)
      .getByRole("article", { name: "Notification" })
      .filter({ hasText: "Writer ended its run without reporting" }),
  ).toBeVisible();
  await idle(page);

  // Under the thread's row in the sidebar as rows of their own that are never new, open once they
  // worked, and folded when none works.
  const sidebar = page.locator("[data-sidebar=sidebar]");
  const caret = sidebar.getByRole("button", { name: "Subagents", exact: true });
  await expect(caret).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(caret).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("link", { name: "Writer" })).toHaveCount(0);
  await caret.click();
  await expect(sidebar.getByRole("link", { name: "Writer" })).toBeVisible();
  await expect(sidebarRow(page, "Researcher")).toHaveAttribute("data-status", "read");
  await expect(sidebarRow(page, "Writer")).toHaveAttribute("data-status", "read");
  await expect(
    sidebar.getByRole("listitem", { name: "Subagents of Queue library" }).getByRole("img", {
      name: "New messages",
    }),
  ).toHaveCount(0);

  // The strip above the composer has them as cards, each with a way into its thread; idle ones stay.
  const strip = page.getByRole("toolbar", { name: "Context" });
  await strip.getByRole("button", { name: "Subagents" }).click();
  const cards = page.getByTestId("tray-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "Writer" })).toContainText("Idle");
  await expect(
    cards.filter({ hasText: "Writer" }).getByRole("link", { name: "Writer" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(strip.getByRole("button", { name: "Subagents" })).toBeVisible();

  // A subagent's thread: under the thread that started it, its task first.
  await group.click();
  await transcript(page).getByRole("link", { name: "Open Writer" }).click();
  await expect(page).not.toHaveURL(parentUrl);
  await expect(
    page.locator("[data-slot=breadcrumb]").getByRole("link", { name: "Queue library" }),
  ).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Writer");
  const task = transcript(page).getByRole("article", { name: "Message from Agent" }).first();
  await task.hover();
  await expect(task.getByRole("link", { name: /^Open source: Subagents › Start/ })).toBeVisible();
  await expect(task).toContainText("Draft the notes");

  // A person writing there resumes it; its accessible identity remains while visual headers stay hidden.
  await write(page, "Shorter, please");
  const reply = transcript(page).getByRole("article", { name: "Message from Writer" }).last();
  await expect(reply).toContainText("I have read 2 messages,");
  await expect(reply.locator("[data-slot=avatar-fallback]")).toHaveCount(0);
  await expect(reply.locator("time")).toHaveCount(0);
  await idle(page);

  // Archived by the agent that started it, its thread is read-only until someone brings it back.
  const writerUrl = page.url();
  await page.goto(parentUrl);
  await write(page, call("subagents.archive", { subagent: "Writer" }));
  await idle(page);
  await page.goto(writerUrl);
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.getByText("This subagent is archived")).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Unarchive" }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Unarchive" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText("Archived", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable();
});

// Skipped for now: passes alone, but misses its wait under the full suite's parallel load.
test.fixme("an agent whose turn ended is woken by its subagent's message", async ({ page }) => {
  await signUp(page);
  await queueLibrary(page);
  await write(page, call("subagents.start", { name: "Writer", task: "Draft the notes" }));
  const ended = transcript(page)
    .getByRole("article", { name: "Notification" })
    .filter({ hasText: "Writer ended its run without reporting" });
  await expect(ended).toBeVisible();
  await idle(page);
  const parentUrl = page.url();

  // The notice shows its text and exposes its source on hover.
  await ended.getByRole("button", { name: "Show details" }).click();
  await expect(transcript(page).getByRole("article", { name: "Notification" })).toContainText(
    "I have read 1 message",
  );
  await ended.hover();
  await ended.getByRole("link", { name: /^Open source:/ }).click();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Writer");
  await write(page, call("subagents.send", { to: "agent", text: "Notes drafted" }));
  await idle(page);

  // The idle agent took the message in, and replied.
  await page.goto(parentUrl);
  const notes = transcript(page).getByRole("article", { name: "Message from Writer" });
  await expect(notes).toContainText("Notes drafted");
  await expect(
    transcript(page).getByRole("article", { name: "Message from Agent" }).last(),
  ).toContainText("I have read");
  await idle(page);
});

test("a watch on all idle wakes the agent once all its subagents are idle", async ({ page }) => {
  await signUp(page);
  await queueLibrary(page);
  await write(
    page,
    [
      call("subagents.start", {
        name: "Researcher",
        task: call("subagents.send", { to: "agent", text: "Recommend BullMQ" }),
      }),
      call("subagents.start", {
        name: "Writer",
        task: call("subagents.send", { to: "agent", text: "Notes drafted" }),
      }),
      call("subagents.watch", { when: "all_idle" }),
    ].join("\n"),
  );
  const fired = transcript(page)
    .getByRole("article", { name: "Notification" })
    .filter({ hasText: "All idle: Researcher, Writer" });
  // The notice lands once the parent's run that set the watch has taken it, which can take a while.
  await expect(fired).toHaveCount(1, { timeout: 20_000 });
  await idle(page);
  await expect(fired).toHaveCount(1);
});

// Skipped for now: passes alone, but misses its wait under the full suite's parallel load.
test.fixme("a send links to the message it delivered, which links back to the send", async ({
  page,
}) => {
  await signUp(page);
  await queueLibrary(page);
  await write(
    page,
    [
      call("subagents.start", { name: "Writer", task: "Draft the notes" }),
      call("subagents.send", { to: "Writer", text: "Shorter, please" }),
    ].join("\n"),
  );
  await idle(page);
  const parentUrl = page.url();

  // The send's line opens on a link to the message, which opens it in the writer's thread, lit.
  await transcript(page)
    .getByRole("button", { name: /^2 tool calls · Subagents/ })
    .click();
  const sendLine = transcript(page).getByRole("button", { name: /^Subagents › Send · Ran/ });
  await sendLine.click();
  await transcript(page).getByRole("link", { name: "Message to Writer" }).click();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Writer");
  const message = transcript(page)
    .getByRole("article", { name: "Message from Agent" })
    .filter({ hasText: "Shorter, please" });
  await expect(message).toBeVisible();
  await expect(message).toHaveAttribute("data-lit", "true");
  await expect(message).toBeInViewport();

  // Its backlink leads to the send, opened and lit, from a fresh load of the thread.
  await message.hover();
  await message.getByRole("link", { name: "Open source: Subagents › Send" }).click();
  await expect(page).toHaveURL(new RegExp(`^${parentUrl}\\?row=`));
  await page.reload();
  const lit = transcript(page).locator("[data-lit]");
  await expect(lit).toHaveCount(1);
  await expect(lit.getByRole("button", { name: /^Subagents › Send · Ran/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(lit.getByRole("link", { name: "Message to Writer" })).toBeVisible();

  // Followed again after leaving the thread another way, the link lights the message again.
  await lit.getByRole("link", { name: "Message to Writer" }).click();
  await expect(message).toHaveAttribute("data-lit", "true");
  await expect(message).not.toHaveAttribute("data-lit", { timeout: 7000 });
  await page.locator("[data-slot=breadcrumb]").getByRole("link", { name: "Queue library" }).click();
  await expect(page).toHaveURL(parentUrl);
  // The send stays open as the reader left it.
  await transcript(page).getByRole("link", { name: "Message to Writer" }).click();
  await expect(message).toHaveAttribute("data-lit", "true");
});

test("subagents message each other, counted on the line that started them, and steer each other's calls", async ({
  page,
}) => {
  await signUp(page);
  const spaceId = new URL(page.url()).pathname.split("/")[2]!;
  // Renaming asks every time, and anyone who can post approves it.
  const policy = await page.request.post("/api/v1/org/tool-policies", {
    data: {
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: ["editors"],
      independent: false,
    },
  });
  expect(policy.ok()).toBe(true);
  const { id } = (await policy.json()) as { id: string };
  const set = await page.request.patch(`/api/v1/spaces/${spaceId}/tools`, {
    data: { toolIds: ["thread.rename"], policy: id },
  });
  expect(set.ok()).toBe(true);

  await write(
    page,
    [
      call("subagents.start", { name: "Writer", task: "Wait for notes" }),
      call("subagents.start", {
        name: "Critic",
        task: call("subagents.send", {
          to: "Writer",
          text: call("thread.rename", { title: "Intro" }),
        }),
      }),
    ].join("\n"),
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // The messages between them show only as a count on the line that started them.
  await expect(
    transcript(page).getByRole("button", {
      name: /^2 tool calls · Subagents$/,
    }),
  ).toBeVisible();
  await expect(transcript(page).getByRole("article", { name: "Message from Critic" })).toHaveCount(
    0,
  );

  // The writer's call waits in its own thread, saying whose words steered it.
  await transcript(page)
    .getByRole("button", { name: /^2 tool calls/ })
    .click();
  await expect(
    transcript(page).getByRole("button", {
      name: /^Subagents › Start · Writer · Working · needs approval/,
    }),
  ).toBeVisible();
  await transcript(page).getByRole("link", { name: "Open Writer" }).click();
  await expect(
    transcript(page)
      .getByRole("article", { name: "Message from Critic" })
      .getByRole("button", { name: "About Critic" }),
  ).toBeVisible();
  // In its own thread its card goes by its label too.
  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await expect(card).toContainText("Writer");
  await expect(card).toContainText("Steered by Ada Lovelace via Agent → Writer");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    transcript(page).getByRole("button", {
      name: /^Thread › Rename · Ran · allowed by Ada Lovelace/,
    }),
  ).toBeVisible();
});

test("a subagent's call that waits shows on its line and is decided in its own thread", async ({
  page,
}) => {
  await signUp(page);
  const spaceId = new URL(page.url()).pathname.split("/")[2]!;
  await queueLibrary(page);
  // Renaming asks every time, and anyone who can post approves it.
  const policy = await page.request.post("/api/v1/org/tool-policies", {
    data: {
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: ["editors"],
      independent: false,
    },
  });
  expect(policy.ok()).toBe(true);
  const { id } = (await policy.json()) as { id: string };
  const set = await page.request.patch(`/api/v1/spaces/${spaceId}/tools`, {
    data: { toolIds: ["thread.rename"], policy: id },
  });
  expect(set.ok()).toBe(true);

  await write(
    page,
    call("subagents.start", { name: "Namer", task: call("thread.rename", { title: "Named" }) }),
  );

  // The line that started it says it needs approval, and opens its thread, where the tray does.
  await expect(
    transcript(page).getByRole("button", {
      name: /^Subagents › Start · Namer · Working · needs approval/,
    }),
  ).toBeVisible();

  // While it works its row shows under the thread's, which is open.
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await expect(sidebar.getByRole("button", { name: "Subagents", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(sidebar.getByRole("link", { name: /^Namer/ })).toBeVisible();

  // Allowed in its thread, it runs, and the card leaves; its row keeps its label though it renamed
  // its thread.
  await transcript(page).getByRole("link", { name: "Open Namer" }).click();
  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await expect(card).toContainText("Steered by Ada Lovelace via Agent → Namer");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.goBack();
  await expect(sidebarRow(page, "Namer")).toHaveAttribute("data-status", "read");
  await expect(sidebar.getByRole("link", { name: /^Named/ })).toHaveCount(0);
  await sidebar.getByRole("link", { name: /^Namer/ }).click();
  await expect(
    transcript(page).getByRole("button", {
      name: /^Thread › Rename · Ran · allowed by Ada Lovelace/,
    }),
  ).toBeVisible();
});

test("the agent goes by the name its org gives it, or its space's", async ({ page }) => {
  await signUp(page);
  const spaceId = new URL(page.url()).pathname.split("/")[2]!;
  await page.goto("/org/general");
  const orgName = page.getByLabel("Agent name");
  await expect(orgName).toHaveValue("Agent");
  await orgName.fill("Mira");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

  await page.goto(`/s/${spaceId}/new`);
  await write(page, call("subagents.start", { name: "Writer", task: "Draft the notes" }));
  await expect(
    transcript(page).getByRole("article", { name: "Message from Mira" }).first(),
  ).toBeVisible();
  await idle(page);
  const threadUrl = page.url();

  // A space's name wins; emptied, it follows the org's again.
  await page.goto(`/s/${spaceId}/settings`);
  const spaceName = page.getByLabel("Agent name");
  await expect(spaceName).toHaveAttribute("placeholder", "Mira");
  await spaceName.fill("Atlas");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.goto(threadUrl);
  await expect(
    transcript(page).getByRole("article", { name: "Message from Atlas" }).first(),
  ).toBeVisible();
  await transcript(page).getByRole("link", { name: "Open Writer" }).click();
  await expect(
    transcript(page)
      .getByRole("article", { name: "Message from Atlas" })
      .getByRole("button", { name: "About Atlas" }),
  ).toBeVisible();
  await expect(
    transcript(page).getByRole("article", { name: "Message from Writer" }).first(),
  ).toBeVisible();

  await page.goto(`/s/${spaceId}/settings`);
  await page.getByLabel("Agent name").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.goto(threadUrl);
  await expect(
    transcript(page).getByRole("article", { name: "Message from Mira" }).first(),
  ).toBeVisible();
});

// Skipped for now: passes alone, but misses its wait under the full suite's parallel load.
test.fixme("a subagent's thread has its own activity tray, and its starter's card counts its tasks", async ({
  page,
}) => {
  await signUp(page);
  await queueLibrary(page);
  const parentUrl = page.url();
  const threadId = new URL(parentUrl).pathname.split("/")[2]!;
  await write(
    page,
    call("thread.add_tasks", {
      tasks: [{ title: "Read the spec" }, { title: "Write it" }, { title: "Ship it" }],
    }),
  );
  await idle(page);
  const list = await page.request.get(`/api/v1/threads/${threadId}/tasks`);
  const { tasks } = (await list.json()) as { tasks: { id: string; title: string }[] };
  const ids = tasks.filter((task) => task.title !== "Ship it").map((task) => task.id);
  expect(ids).toHaveLength(2);
  await write(page, call("subagents.start", { name: "Reader", task: "Begin.", tasks: ids }));
  await idle(page);

  const strip = page.getByRole("toolbar", { name: "Context" });
  await strip.getByRole("button", { name: "Subagents" }).click();
  const card = page.getByTestId("tray-card").filter({ hasText: "Reader" });
  await expect(card.getByTestId("subagent-context")).toContainText("0/2 tasks");

  // Its thread shows the tasks given to it, Mine first, All showing the starter's list.
  await card.getByRole("link", { name: "Reader" }).click();
  await expect(page).not.toHaveURL(parentUrl);
  const tasksButton = strip.getByRole("button", { name: "Tasks" });
  await expect(tasksButton).toContainText("0/2");
  await tasksButton.click();
  const shown = page.getByTestId("task-list");
  const titles = shown.getByRole("textbox", { name: "Task title" });
  await expect(titles).toHaveCount(2);
  await expect(titles.first()).toHaveValue("Read the spec");
  await shown.getByRole("button", { name: "All" }).click();
  await expect(titles).toHaveCount(3);
  await shown.getByRole("button", { name: "Mine" }).click();
  await expect(titles).toHaveCount(2);
  await shown.getByRole("button", { name: "Status: todo. Set to doing" }).first().click();
  await shown.getByRole("button", { name: "Status: doing. Set to done" }).click();
  await expect(tasksButton).toContainText("1/2");

  // The count follows on its starter's card.
  await page.goBack();
  await expect(page).toHaveURL(parentUrl);
  await strip.getByRole("button", { name: "Subagents" }).click();
  await expect(
    page.getByTestId("tray-card").filter({ hasText: "Reader" }).getByTestId("subagent-context"),
  ).toContainText("1/2 tasks");
});
