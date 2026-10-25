import { expect, type Page, test } from "@playwright/test";

import { modelServer } from "./servers.ts";

// Sign-ups are rate limited per client address; each journey counts as its own client.
let client = 60;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `198.51.${testInfo.parallelIndex}.${client}`,
  });
});

async function signUpToProviders(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await page.goto("/org/providers");
}

// Writes a message in a new thread, and the sidebar row it makes, the person's only one.
async function newThread(page: Page, text: string) {
  await page.goto("/");
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  return page.getByRole("list", { name: "Today" }).locator("[data-sidebar=menu-item]").first();
}

test("a server people run connects at its address, its models marked by maker and server", async ({
  page,
}) => {
  await signUpToProviders(page);
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  // Found by searching, among the self-hosted kinds.
  await dialog.getByPlaceholder("Search providers").fill("compatible");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("option", { name: /^OpenAI-compatible ·/ }).click();
  await expect(dialog.getByRole("heading", { name: "Connect OpenAI-compatible" })).toBeVisible();

  await dialog.getByLabel("Base URL").fill(`${modelServer}/nowhere`);
  await dialog.getByLabel("Label").fill("Lab box");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByRole("alert")).toContainText("did not accept these details");
  await dialog.getByLabel("Base URL").fill(`${modelServer}/v1`);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connected · 2 models found");
  await dialog.getByLabel("Set as default model (optional)").click();
  await page.getByRole("listbox").getByRole("option", { name: "llama-3.3-70b-instruct" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row", { name: "OpenAI-compatible · Lab box" });
  await expect(row).toContainText(new URL(modelServer).host);
  await expect(row).toContainText("Server");
  await expect(row.getByRole("img", { name: "Makers: Meta" })).toBeVisible();

  const thread = await newThread(page, "Hello from the lab");
  const tile = thread.locator("[data-maker]");
  await expect(tile).toHaveAttribute("data-maker", "meta");
  await expect(tile.locator("[data-host]")).toHaveCount(0);
  await expect(
    thread.getByRole("img", { name: "llama-3.3-70b-instruct · OpenAI-compatible · Lab box" }),
  ).toBeAttached();
});

test("a provider's label and server address are changed in the form it was added with", async ({
  page,
}) => {
  await signUpToProviders(page);
  await page.getByRole("button", { name: "Add provider" }).click();
  const adding = page.getByRole("dialog");
  await adding.getByPlaceholder("Search providers").fill("compatible");
  await adding.getByRole("option", { name: /^OpenAI-compatible ·/ }).click();
  await adding.getByLabel("Base URL").fill(`${modelServer}/v1`);
  await adding.getByLabel("Label").fill("Lab box");
  await adding.getByRole("button", { name: "Connect" }).click();
  await expect(adding.getByRole("status")).toContainText("Connected · 2 models found");
  await adding.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row", { name: "OpenAI-compatible · Lab box" });
  await row.getByRole("button", { name: "Actions for OpenAI-compatible · Lab box" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit OpenAI-compatible · Lab box" });
  await expect(dialog.getByLabel("Label")).toHaveValue("Lab box");
  await expect(dialog.getByLabel("Base URL")).toHaveValue(`${modelServer}/v1`);
  await dialog.getByLabel("Label").fill("Lab");
  await dialog.getByLabel("Base URL").fill(`${modelServer}/nowhere`);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("did not accept these details");

  // The same server by another address, with a model it does not list.
  const moved = `http://127.0.0.1:${new URL(modelServer).port}/v1`;
  await dialog.getByLabel("Base URL").fill(moved);
  await dialog.getByLabel("Model ids").fill("my-tune");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const changed = page.getByRole("row", { name: "OpenAI-compatible · Lab", exact: true });
  await expect(changed).toContainText(new URL(moved).host);
  await expect(
    changed.getByRole("button", { name: "Models of OpenAI-compatible · Lab" }),
  ).toHaveText("3 of 3 on");
});

test("Amazon Bedrock connects with access keys in a region, Claude marked as served by Bedrock", async ({
  page,
}) => {
  await signUpToProviders(page);
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: /^Amazon Bedrock ·/ }).click();
  await expect(dialog.getByRole("button", { name: /^Bedrock API key/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Assume a role/ })).toBeVisible();
  await dialog.getByRole("button", { name: /^Access keys/ }).click();
  await expect(dialog.getByRole("heading", { name: "Connect Amazon Bedrock" })).toBeVisible();

  await dialog.getByLabel("Region").click();
  await page.getByRole("option", { name: "eu-west-1" }).click();
  await dialog.getByLabel("Access key ID").fill("AKIAEXAMPLE1234");
  await dialog.getByLabel("Secret access key").fill("wrong-secret");
  await expect(dialog.getByRole("button", { name: "Connect" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Connect" }).click();
  // The stand-in refuses secrets starting with "wrong".
  await expect(dialog.getByRole("alert")).toContainText(
    "Amazon Bedrock did not accept these details",
  );
  await dialog.getByLabel("Secret access key").fill("right-secret");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connected · 4 models found");
  await dialog.getByLabel("Set as default model (optional)").click();
  await page.getByRole("listbox").getByRole("option", { name: "Claude Echo" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row", { name: "Amazon Bedrock" });
  await expect(row).toContainText("Access keys");
  await expect(row).toContainText("AKIA…1234 · eu-west-1");
  await expect(row).not.toContainText("right-secret");
  await expect(row.getByRole("img", { name: /^Makers: Anthropic, Meta/ })).toBeVisible();

  const thread = await newThread(page, "Hello from the cloud");
  const tile = thread.locator("[data-maker]");
  await expect(tile).toHaveAttribute("data-maker", "anthropic");
  await expect(tile.locator("[data-host]")).toHaveCount(0);
  await expect(
    thread.getByRole("img", {
      name: "Claude Echo · Amazon Bedrock",
    }),
  ).toBeAttached();

  // The picker finds it by its host and maker, under its connection.
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByLabel("Search models").fill("bedrock claude");
  const list = page.getByRole("listbox");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByText("Amazon Bedrock", { exact: true })).toBeVisible();
});
