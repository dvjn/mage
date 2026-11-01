import { type Browser, expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";
import { mcpServer } from "./servers.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 10;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.5.${index}.${client}` };
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

async function someoneElse(browser: Browser, index: number) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  return context.newPage();
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

// Connects in the dialog that allowing a call opened, with the person's own token.
async function connectWith(page: Page, token: string) {
  const dialog = page.getByRole("dialog", { name: "Connect to People" });
  await dialog.getByLabel("Bearer token").fill(token);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();
}

// The newest approval card in the thread.
function approval(page: Page) {
  return transcript(page).getByRole("article", { name: "Approval request" }).last();
}

// The output of the thread's call at `index`, opened once its line reads `line`. Calls are picked
// by position, not as the last line that matches: the agent writes its words before it calls, so a
// newer call can still be running when its reply shows, and the last match would be an older call
// whose open output the click then closes.
async function outputOf(page: Page, index: number, line: RegExp) {
  const call = transcript(page)
    .getByRole("button", { name: /^People › Echo · / })
    .nth(index);
  await expect(call).toHaveAccessibleName(line);
  await call.click();
  return call.locator("..").getByRole("region", { name: "Output" });
}

test("a server with personal credentials runs each call with its approver's own login", async ({
  page,
  browser,
}, testInfo) => {
  // Three people, each signing up, through four calls the agent replies to: longer than the default
  // allows once the other workers load the machine.
  test.setTimeout(90_000);
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = new URL(page.url()).pathname.split("/")[2]!;

  // Ada adds the server with her own token, which only reads its tools, and reads them again.
  await page.goto("/org/tools");
  await page.getByRole("button", { name: "Add server" }).click();
  const add = page.getByRole("dialog", { name: "Add MCP server" });
  await add.getByLabel("Name", { exact: true }).fill("People");
  await add.getByLabel("Server URL").fill(`${mcpServer}/people/mcp`);
  await add.getByRole("button", { name: "Headers" }).click();
  await add.getByLabel("Bearer token").fill("person-ada");
  await add.getByRole("button", { name: "Personal" }).click();
  await add.getByRole("button", { name: "Add server" }).click();
  await expect(page).toHaveURL(/\/tools\/mcp\/[^/]+$/);
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(page.getByText("Calls run with each person's own.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh tools" }).click();
  await expect(page.getByRole("group", { name: "Read-only tools", exact: true })).toContainText(
    "Echo",
  );

  // Grace, alone in her thread with no connection, is asked to approve, and connects as she does.
  const grace = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(grace, "Grace Hopper"), "messager");
  await grace.goto(`/s/${spaceId}`);
  await write(grace, '/tool mcp.people.echo {"text":"hello"}');
  await expect(grace).toHaveURL(/\/t\/[^/]+$/);
  await approval(grace).getByRole("button", { name: "Allow", exact: true }).click();
  await connectWith(grace, "person-grace");
  const first = await outputOf(
    grace,
    0,
    /^People › Echo · Ran · allowed by Grace Hopper · as Grace Hopper$/,
  );
  await expect(first).toContainText("grace: hello");
  await expect(transcript(grace)).toContainText("I have read 1 message");
  const thread = grace.url();

  // Once Ada has written too, Grace's next call waits though anyone may use the tool. Alan approves
  // it, connecting as he does, and it runs with his token.
  await page.goto(thread);
  await write(page, "Hello all");
  await expect(transcript(page)).toContainText("I have read 2 messages");
  const alan = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(alan, "Alan Turing"), "messager");
  await write(grace, '/tool mcp.people.echo {"text":"again"}');
  await alan.goto(thread);
  await expect(approval(alan)).toContainText("Echo");
  await approval(alan).getByRole("button", { name: "Allow", exact: true }).click();
  await connectWith(alan, "person-alan");
  const second = await outputOf(
    alan,
    1,
    /^People › Echo · Ran · allowed by Alan Turing · as Alan Turing$/,
  );
  await expect(second).toContainText("alan: again");
  await expect(transcript(alan)).toContainText("I have read 3 messages");

  // Grace allows her next call for now: her later calls run with her login until someone else
  // writes.
  await write(grace, '/tool mcp.people.echo {"text":"three"}');
  await approval(grace).getByRole("button", { name: "Allow for now" }).click();
  const third = await outputOf(
    grace,
    2,
    /^People › Echo · Ran · allowed for now by Grace Hopper · as Grace Hopper$/,
  );
  await expect(third).toContainText("grace: three");
  await expect(transcript(grace)).toContainText("I have read 4 messages");
  await write(grace, '/tool mcp.people.echo {"text":"four"}');
  await expect(transcript(grace)).toContainText("I have read 5 messages");
  const fourth = await outputOf(
    grace,
    3,
    /^People › Echo · Ran · allowed for now by Grace Hopper · as Grace Hopper$/,
  );
  await expect(fourth).toContainText("grace: four");
  await write(alan, '/tool mcp.people.echo {"text":"five"}');
  await expect(approval(alan)).toContainText("Echo");
  await expect(approval(alan).getByRole("button", { name: "Allow for now" })).toBeVisible();

  // Alan's connection is his to see and let go.
  await alan.goto("/account");
  const people = alan.getByRole("region", { name: "People" });
  await expect(people).toContainText("Connected");
  await people.getByRole("button", { name: "Disconnect" }).click();
  await expect(people).toContainText("Not connected");
});
