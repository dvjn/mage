import { expect, type Page, test } from "@playwright/test";

import { modelServer } from "./servers.ts";

// The stand-in model reached through Mage's real providers, over each wire protocol they speak:
// its connection checked by listing its models, its reply streamed, a tool call made and its
// result read back, and a refusal sorted as the provider's.

let client = 700;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `198.18.${testInfo.parallelIndex}.${client}`,
  });
});

interface Wire {
  protocol: string;
  option: RegExp;
  model: string;
  // How the connection is made: a server's own address, or a key sent through a proxy.
  connect: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>;
}

function throughProxy(key: string, base: string) {
  return async (dialog: ReturnType<Page["getByRole"]>) => {
    await dialog.getByLabel("API key").fill(key);
    await dialog.getByRole("button", { name: "Advanced" }).click();
    await dialog
      .getByRole("region", { name: "Proxy" })
      .getByLabel("Base URL")
      .fill(`${modelServer}${base}`);
    await dialog.getByRole("button", { name: "Add key" }).click();
  };
}

const wires: Wire[] = [
  {
    protocol: "OpenAI Chat Completions",
    option: /^OpenAI-compatible ·/,
    model: "lab-tune-7b",
    connect: async (dialog) => {
      await dialog.getByLabel("Base URL").fill(`${modelServer}/v1`);
      await dialog.getByRole("button", { name: "Connect" }).click();
    },
  },
  {
    protocol: "Anthropic Messages",
    option: /^Anthropic ·/,
    model: "Claude Echo 5",
    connect: throughProxy("sk-ant-wire", "/anthropic/v1"),
  },
  {
    protocol: "OpenAI Responses",
    option: /^OpenAI ·/,
    model: "gpt-5-echo",
    connect: throughProxy("sk-wire", "/openai/v1"),
  },
  {
    protocol: "Gemini",
    option: /^Gemini API ·/,
    model: "gemini-echo",
    connect: throughProxy("AIza-wire", "/google/v1beta"),
  },
];

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

// Connects the provider and makes its model the default.
async function connect(page: Page, wire: Wire) {
  await page.goto("/org/providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: wire.option }).click();
  await wire.connect(dialog);
  await expect(dialog.getByRole("status")).toContainText("Connected");
  await dialog.getByLabel("Set as default model (optional)").click();
  await page.getByRole("listbox").getByRole("option", { name: wire.model }).click();
  await dialog.getByRole("button", { name: "Done" }).click();
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

for (const wire of wires) {
  test(`over ${wire.protocol}, the model streams its reply and calls a tool`, async ({ page }) => {
    await signUp(page);
    await connect(page, wire);

    await page.goto("/");
    await write(page, '^tool thread.rename {"title":"Over the wire"}');
    await expect(page).toHaveURL(/\/t\/[^/]+$/);
    const events = page.getByRole("log", { name: "Events" });
    await expect(events).toContainText("I have read 1 message");
    // It read back what the call gave.
    await expect(events).toContainText("said: ok");
    await expect(events.getByRole("button", { name: /^Thread › Rename · Ran/ })).toBeVisible();
  });
}

test("a refusal over the wire shows as the provider's, with what it said", async ({ page }) => {
  await signUp(page);
  await connect(page, wires[1]!);
  await page.goto("/");
  await write(page, "^status 401 The key was revoked.");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.getByRole("log", { name: "Events" })).toContainText("The key was revoked.");
});
