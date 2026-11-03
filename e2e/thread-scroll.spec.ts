import { type Browser, expect, type Page, test } from "@playwright/test";

import { addNotesThread, addThreads, joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 10;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.4.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function signUp(page: Page, name: string) {
  const email = `${crypto.randomUUID()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  return email;
}

async function someoneElse(browser: Browser, index: number, name: string) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  const page = await context.newPage();
  return { page, email: await signUp(page, name) };
}

function sidebar(page: Page) {
  return page.locator("[data-sidebar=sidebar]");
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function note(page: Page, n: number) {
  return transcript(page).getByText(`Note ${n}`, { exact: true });
}

// The transcript's scrolling box, in the page.
const scroller = `document.querySelector('[role=log][aria-label=Events] [style*=scrollbar-gutter]')`;

// How far the transcript is from its end, read the moment it is asked.
async function distanceFromEnd(page: Page) {
  const distance = await page.evaluate(
    `(() => { const s = ${scroller}; return s.scrollHeight - s.clientHeight - s.scrollTop; })()`,
  );
  return distance as number;
}

// The thread is at its end as soon as its newest note is in place, not after scrolling there.
async function expectOpenAtEnd(page: Page, last = 40) {
  await expect(note(page, last)).toBeAttached();
  expect(await distanceFromEnd(page)).toBeLessThan(2);
  await expect(note(page, last)).toBeInViewport();
  await expect(note(page, 1)).not.toBeInViewport();
}

test("a long thread opens at its newest message, from a link and from another thread", async ({
  page,
}) => {
  const email = await signUp(page, "Ada Lovelace");
  addThreads(email, 1, { prefix: "Short" });
  const long = addNotesThread(email, "Long notes", 40);

  await page.goto(`/t/${long}`);
  await expectOpenAtEnd(page);

  // Scrolled up, then away and back: it opens at the end again.
  await page.evaluate(`${scroller}.scrollTop = 0`);
  await expect(note(page, 1)).toBeInViewport();
  await sidebar(page)
    .getByRole("link", { name: /^Short 1/ })
    .click();
  await expect(note(page, 1)).toHaveCount(0);
  await sidebar(page)
    .getByRole("link", { name: /^Long notes/ })
    .click();
  await expectOpenAtEnd(page);
});

test("a reply streaming into a long thread stays in view, unless the reader scrolls up", async ({
  page,
}) => {
  const email = await signUp(page, "Ada Lovelace");
  const long = addNotesThread(email, "Long notes", 40);
  await page.goto(`/t/${long}`);
  await expectOpenAtEnd(page);

  const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the reply.`);
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(`/say\n${lines.join("\n\n")}`);
  await box.press("Enter");
  const reply = transcript(page).getByRole("article", { name: "Message from Agent" });
  await expect(reply).toContainText("Line 12 of the reply.");
  await expect(reply.getByText("Line 12 of the reply.")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Scroll to end" })).toHaveCount(0);

  // Scrolled up, the next reply leaves the reader where they are until they go back down.
  await transcript(page).locator("[style*=scrollbar-gutter]").hover();
  await page.mouse.wheel(0, -5000);
  await expect(page.getByRole("button", { name: "Scroll to end" })).toBeVisible();
  await expect(reply.getByText("Line 12 of the reply.")).not.toBeInViewport();
  const at = await distanceFromEnd(page);
  await box.fill("/say\nAnother reply.");
  await box.press("Enter");
  await expect(reply.last()).toContainText("Another reply.");
  expect(await distanceFromEnd(page)).toBeGreaterThan(at);
  await page.getByRole("button", { name: "Scroll to end" }).click();
  await expect(reply.last().getByText("Another reply.")).toBeInViewport();
});

test("an unread thread opens where the reader stopped, and sticks to the end once they reach it", async ({
  page,
  browser,
}, testInfo) => {
  const email = await signUp(page, "Ada Lovelace");
  const grace = await someoneElse(browser, testInfo.parallelIndex, "Grace Hopper");
  addThreads(email, 1, { prefix: "Short" });
  const thread = addNotesThread(email, "Catching up", 30, { email: grace.email, count: 10 });

  await page.goto(`/t/${thread}`);
  await expect(note(page, 31)).toBeInViewport();
  const top = (await transcript(page).boundingBox())!.y;
  expect((await note(page, 31).boundingBox())!.y - top).toBeLessThan(80);
  await expect(note(page, 40)).not.toBeInViewport();
  await expect(page.getByRole("button", { name: "Scroll to end" })).toBeVisible();

  // Down at the end, a reply keeps the end in view.
  await page.getByRole("button", { name: "Scroll to end" }).click();
  await expect(note(page, 40)).toBeInViewport();
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("/say\nCaught up.");
  await box.press("Enter");
  const reply = transcript(page).getByRole("article", { name: "Message from Agent" });
  await expect(reply.getByText("Caught up.")).toBeInViewport();

  // Read now, it opens at the end.
  await sidebar(page)
    .getByRole("link", { name: /^Short 1/ })
    .click();
  await expect(note(page, 1)).toHaveCount(0);
  await sidebar(page)
    .getByRole("link", { name: /^Catching up/ })
    .click();
  await expect(reply.getByText("Caught up.")).toBeInViewport();
  expect(await distanceFromEnd(page)).toBeLessThan(2);
});

// A reply long enough to still be streaming when the reader comes back.
const LONG_REPLY = Array.from({ length: 50 }, (_, i) => `Streamed line ${i + 1}.`).join("\n\n");

// The thread as the person signed in on `page` reads it from the server.
async function read(page: Page, thread: string) {
  const res = await page.request.get(`/api/v1/threads/${thread}`);
  return (await res.json()) as {
    thread: { spaceId: string };
    rows: { kind: string; seq: number }[];
  };
}

// How far the person signed in on `page` has seen the thread, as its space's list says.
async function seenSeq(page: Page, thread: string) {
  const { spaceId } = (await read(page, thread)).thread;
  const res = await page.request.get(`/api/v1/spaces/${spaceId}/threads`);
  const list = (await res.json()) as { id: string; activity: { lastSeenSeq: number } }[];
  return list.find((item) => item.id === thread)?.activity.lastSeenSeq ?? 0;
}

// Waits for the reply to start, answering its seq.
async function replyStarted(page: Page, thread: string) {
  let started = 0;
  await expect
    .poll(async () => {
      started = (await read(page, thread)).rows.find((row) => row.kind === "agent")?.seq ?? 0;
      return started;
    })
    .toBeGreaterThan(0);
  return started;
}

test("coming back while a reply streams opens at what is new, and follows only from the end", async ({
  page,
  browser,
}, testInfo) => {
  const email = await signUp(page, "Ada Lovelace");
  const grace = await someoneElse(browser, testInfo.parallelIndex, "Grace Hopper");
  const org = joinSpaceOf(email, grace.email, "messager");
  addThreads(email, 1, { prefix: "Short" });
  const thread = addNotesThread(email, "Catching up", 30);
  await page.goto(`/t/${thread}`);
  await expectOpenAtEnd(page, 30);
  await sidebar(page)
    .getByRole("link", { name: /^Short 1/ })
    .click();
  await expect(note(page, 1)).toHaveCount(0);

  // Grace asks for a long reply while Ada is away; Ada comes back while it streams, to Grace's
  // message with room under it. Her own tab still names her personal org to the
  // server, so the request names Ada's.
  const posted = await grace.page.request.post(`/api/v1/threads/${thread}/messages`, {
    headers: { "X-Mage-Org": org },
    data: { text: "Reply very slowly.", mode: "steer" },
  });
  expect(posted.ok()).toBe(true);
  await replyStarted(page, thread);
  await sidebar(page)
    .getByRole("link", { name: /^Catching up/ })
    .click();
  const asked = transcript(page).getByText("Reply very slowly.");
  await expect(asked).toBeInViewport();
  const reply = transcript(page).getByRole("article", { name: "Message from Agent" });
  // It stays there while the reply streams on, past the end of the view.
  await expect(reply.locator("[aria-busy=true]")).toHaveCount(0, { timeout: 20_000 });
  await expect(asked).toBeInViewport();
  expect(await distanceFromEnd(page)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Scroll to end" }).click();
  await expect.poll(() => distanceFromEnd(page)).toBeLessThan(2);
});

test("coming back while the reader's own reply streams opens at the end and follows it", async ({
  page,
}) => {
  const email = await signUp(page, "Ada Lovelace");
  addThreads(email, 1, { prefix: "Short" });
  const thread = addNotesThread(email, "Catching up", 30);
  await page.goto(`/t/${thread}`);
  await expectOpenAtEnd(page, 30);
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(`/say\n${LONG_REPLY}`);
  await box.press("Enter");
  await expect(box).toHaveValue("");
  // Away before the reply starts, back while it streams.
  await sidebar(page)
    .getByRole("link", { name: /^Short 1/ })
    .click();
  await expect(note(page, 1)).toHaveCount(0);
  const started = await replyStarted(page, thread);
  await sidebar(page)
    .getByRole("link", { name: /^Catching up/ })
    .click();
  // Read again on coming back, the reply still streaming is not marked new.
  await expect.poll(() => seenSeq(page, thread)).toBeGreaterThanOrEqual(started);
  const reply = transcript(page).getByRole("article", { name: "Message from Agent" });
  await expect(reply).not.toContainText("Streamed line 50.");
  await expect(reply).toContainText("Streamed line 50.", { timeout: 20_000 });
  await expect(reply.getByText("Streamed line 50.")).toBeInViewport();
  // Following the growing reply scrolls smoothly, so the end is reached a moment after it grows.
  await expect.poll(() => distanceFromEnd(page)).toBeLessThan(2);
});

// Where the note is from the top of the transcript's view.
async function topOf(page: Page, n: number) {
  const top = (await transcript(page).boundingBox())!.y;
  return (await note(page, n).boundingBox())!.y - top;
}

// Scrolls to the top until the earliest note is read.
async function readToStart(page: Page) {
  await expect(async () => {
    await page.evaluate(`${scroller}.scrollTop = 0`);
    await expect(note(page, 1)).toBeAttached({ timeout: 500 });
  }).toPass();
}

test("a thread of hundreds of rows opens at its end, and reads earlier rows as the reader scrolls up, without a jump", async ({
  page,
}) => {
  const email = await signUp(page, "Ada Lovelace");
  const long = addNotesThread(email, "Long notes", 320);
  // The first page of earlier rows waits until the view is measured.
  let held: (() => Promise<void>) | undefined;
  await page.route(
    (url) => url.pathname.endsWith("/rows"),
    (route) => {
      if (held) return route.continue();
      held = () => route.continue();
    },
  );

  await page.goto(`/t/${long}`);
  await expect(note(page, 320)).toBeInViewport();
  expect(await distanceFromEnd(page)).toBeLessThan(2);
  await expect(note(page, 221)).toBeAttached();
  await expect(note(page, 220)).toHaveCount(0);

  await page.evaluate(`${scroller}.scrollTop = 0`);
  await expect.poll(() => held !== undefined).toBe(true);
  await expect(note(page, 221)).toBeInViewport();
  const before = await topOf(page, 221);
  await held!();
  await expect(note(page, 220)).toBeAttached();
  expect(Math.abs((await topOf(page, 221)) - before)).toBeLessThan(2);

  // Once the start is read, nothing more loads and the top stays the top.
  await readToStart(page);
  await page.evaluate(`${scroller}.scrollTop = 0`);
  await expect(note(page, 1)).toBeInViewport();
});

test("a new line in an older page of the thread is where it opens", async ({
  page,
  browser,
}, testInfo) => {
  const email = await signUp(page, "Ada Lovelace");
  const grace = await someoneElse(browser, testInfo.parallelIndex, "Grace Hopper");
  const thread = addNotesThread(email, "Catching up", 30, { email: grace.email, count: 250 });

  await page.goto(`/t/${thread}`);
  await expect(note(page, 31)).toBeInViewport();
  await expect.poll(() => topOf(page, 31)).toBeLessThan(80);
  await expect(note(page, 280)).not.toBeInViewport();
  await expect(page.getByRole("button", { name: "Scroll to end" })).toBeVisible();
});

test("a row changes live at the end while the thread's earlier pages are read", async ({
  page,
}) => {
  const email = await signUp(page, "Ada Lovelace");
  const long = addNotesThread(email, "Long notes", 250);
  await page.goto(`/t/${long}`);
  await expect(note(page, 250)).toBeInViewport();
  await readToStart(page);

  const box = page.getByLabel("Message", { exact: true });
  await box.fill("/say\nFresh at the end.");
  await box.press("Enter");
  const reply = transcript(page).getByRole("article", { name: "Message from Agent" });
  await expect(reply).toContainText("Fresh at the end.");
  await expect(reply.locator("[aria-busy=true]")).toHaveCount(0);
  await expect(note(page, 1)).toBeAttached();
  await expect(note(page, 120)).toBeAttached();
  await page.getByRole("button", { name: "Scroll to end" }).click();
  await expect(reply.getByText("Fresh at the end.")).toBeInViewport();
});
