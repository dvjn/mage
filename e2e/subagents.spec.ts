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
  return `/tool ${toolId} ${JSON.stringify(input)}`;
}

// A thread named Queue library, whose agent then starts the subagents.
async function queueLibrary(page: Page) {
  await write(page, call("thread.rename", { title: "Queue library" }));
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Queue library");
  await idle(page);
}

test("the agent starts subagents, who report back, go idle and can be resumed and archived", async ({
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

  // The result comes back as a message, folded into one line until opened, and the agent is told
  // they went idle.
  const relayed = transcript(page).getByRole("article", { name: "Message from Researcher" });
  const relayLine = relayed.getByRole("button", { name: "Researcher → Agent" });
  await expect(relayLine).toBeVisible();
  await expect(relayed).not.toContainText("Recommend BullMQ");
  await relayLine.click();
  await expect(relayed).toContainText("Recommend BullMQ");
  const notice = transcript(page).getByRole("status", { name: "Subagents" });
  await expect(notice.first()).toContainText(/subagents? idle/);
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

  // A subagent's thread: under the thread that started it, its task first.
  await group.click();
  await transcript(page).getByRole("link", { name: "Open Writer" }).click();
  await expect(page).not.toHaveURL(parentUrl);
  await expect(page.getByRole("status", { name: "Subagent" })).toHaveText(
    "Subagent of Queue library · Idle",
  );
  await expect(
    page.getByRole("status", { name: "Subagent" }).getByRole("link", { name: "Queue library" }),
  ).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Writer");
  const task = transcript(page).getByRole("article", { name: "Message from Agent" }).first();
  await task.getByRole("button", { name: "Agent → Writer" }).click();
  await expect(task).toContainText("Sent by Subagents › Start · Writer in Queue library");
  await expect(task).toContainText("Draft the notes");

  // A person writing there resumes it, and its replies there go by its label.
  await write(page, "Shorter, please");
  const reply = transcript(page).getByRole("article", { name: "Message from Writer" }).last();
  await expect(reply).toContainText("I have read 2 messages,");
  await expect(reply).toContainText("Writer");
  await expect(reply.locator("[data-slot=avatar-fallback]")).toHaveText("W");
  await idle(page);

  // Archived by the agent that started it, its thread is read-only until someone brings it back.
  const writerUrl = page.url();
  await page.goto(parentUrl);
  await write(page, call("subagents.archive", { subagent: "Writer" }));
  await idle(page);
  await page.goto(writerUrl);
  await expect(page.getByRole("status", { name: "Subagent" })).toContainText("Archived");
  await expect(page.getByText("This subagent is archived")).toBeVisible();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByRole("status", { name: "Subagent" })).toHaveText(
    "Subagent of Queue library · Idle",
  );
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable();
});

test("a send links to the message it delivered, which links back to the send", async ({ page }) => {
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
  await message.getByRole("link", { name: "Subagents › Send" }).click();
  await expect(page).toHaveURL(new RegExp(`^${parentUrl}\\?row=`));
  await page.reload();
  const lit = transcript(page).locator("[data-lit]");
  await expect(lit).toHaveCount(1);
  await expect(lit.getByRole("button", { name: /^Subagents › Send · Ran/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(lit.getByRole("link", { name: "Message to Writer" })).toBeVisible();
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
      .getByRole("button", { name: "Critic → Writer" }),
  ).toBeVisible();
  // In its own thread its card goes by its label too.
  const card = transcript(page).getByRole("article", { name: "Approval request" });
  await expect(card).toContainText("Writer");
  await expect(card).toContainText("Steered by Ada Lovelace via Agent → Writer");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    transcript(page).getByRole("button", {
      name: /^Thread › Rename · Ran · allowed by Ada Lovelace/,
    }),
  ).toBeVisible();
});

test("a subagent's call that waits is decided from the thread that started it", async ({
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

  // The subagent's call shows here, named for it and saying whose words steered it.
  const card = transcript(page).getByRole("article", { name: "Approval request from Namer" });
  await expect(card).toContainText("Namer wants to run");
  await expect(card).toContainText("Steered by Ada Lovelace via Agent → Namer");

  // While it works its row shows under the thread's, which is open.
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await expect(sidebar.getByRole("button", { name: "Subagents", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(sidebar.getByRole("link", { name: /^Namer/ })).toBeVisible();

  // Allowed from here, it runs in the subagent's thread, and the card leaves; its row keeps its
  // label though it renamed its thread.
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toHaveCount(0);
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
      .getByRole("button", { name: "Atlas → Writer" }),
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
