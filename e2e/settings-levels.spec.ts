import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 120;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.0.${index}.${client}` };
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

async function pickModel(page: Page, label: string, name: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name, exact: true }).click();
}

async function pickEffort(page: Page, scope: Page | ReturnType<Page["locator"]>, name: string) {
  await scope.getByLabel("Reasoning effort").click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("an API key's models become the org's and the space's defaults, which new threads take", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "Organization settings" }).click();
  await expect(page).toHaveURL("/org/general");
  await expect(page.locator("[data-slot=breadcrumb]")).toContainText("Organization");

  const nav = page.getByRole("navigation", { name: "Organization settings" });
  await nav.getByRole("link", { name: "Model providers" }).click();
  await expect(page).toHaveURL("/org/providers");
  await expect(page.getByText("No model providers yet")).toBeVisible();

  // The add-provider journey; the stand-in provider takes keys starting with sk-.
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Anthropic/ }).click();
  await dialog.getByRole("button", { name: /^API key/ }).click();
  await dialog.getByRole("button", { name: "Advanced" }).click();
  await expect(dialog.getByRole("region", { name: "Proxy" })).toContainText("Base URL");
  await dialog.getByRole("button", { name: "Advanced" }).click();
  await dialog.getByLabel("Label").fill("Work");
  await dialog.getByLabel("API key").fill("not-a-key");
  await dialog.getByRole("button", { name: "Add key" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Anthropic did not accept this key");
  await dialog.getByLabel("API key").fill("sk-ant-demo-1234");
  await dialog.getByRole("button", { name: "Add key" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connected · 2 models found");
  await dialog.getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("row", { name: "Anthropic · Work" });
  await expect(row).toContainText("sk-ant-…1234");
  await expect(row).toContainText("API key");

  await nav.getByRole("link", { name: "General" }).click();
  await expect(page).toHaveURL("/org/general");
  await pickModel(page, "Default model", "Echo Mini");
  await expect(page.getByLabel("Default model")).toContainText("Echo Mini");
  await pickEffort(page, page, "High");
  await expect(page.getByLabel("Reasoning effort")).toContainText("High");

  await page
    .locator("[data-sidebar=sidebar]")
    .getByRole("link", { name: "Space settings" })
    .click();
  await expect(page.getByLabel("Default model")).toContainText("Default · Echo Mini");
  await expect(page.getByLabel("Reasoning effort")).toContainText("Default · High");
  await pickModel(page, "Default model", "Echo");
  await expect(page.getByLabel("Default model")).toHaveText(/^Echo$/);
  await pickEffort(page, page, "Low");
  await expect(page.getByLabel("Reasoning effort")).toContainText("Low");

  // A draft starts on the space's defaults; what is picked before sending stays with the thread.
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: "New thread" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+\/new$/);
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toContainText("Default · Echo");
  await expect(page.getByLabel("Reasoning effort")).toContainText("Default · Low");
  await model.click();
  await page.getByRole("listbox").getByRole("option", { name: "Echo", exact: true }).click();
  await expect(model).toContainText("Echo");
  await pickEffort(page, page, "High");
  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(model).not.toContainText("Default");
  await expect(page.getByLabel("Reasoning effort")).toContainText("High");
  await page.reload();
  await expect(model).toHaveText(/^Echo/);
  await expect(page.getByLabel("Reasoning effort")).toContainText("High");

  // Sent back to the defaults, the thread follows them, and its pickers say so.
  await model.click();
  await page.getByRole("button", { name: "Default · Echo" }).click();
  await expect(model).toContainText("Default · Echo");
  await page.getByLabel("Reasoning effort").click();
  await page.getByRole("option", { name: "Default · Low" }).click();
  await expect(page.getByLabel("Reasoning effort")).toContainText("Default · Low");
});

test("a provider is renamed and removed from its row", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await page.goto("/org/providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^OpenAI/ }).click();
  await dialog.getByRole("button", { name: /^API key/ }).click();
  await dialog.getByLabel("API key").fill("sk-proj-demo-9876");
  await dialog.getByRole("button", { name: "Add key" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row", { name: "OpenAI API key" });
  await row.getByRole("button", { name: "Actions for OpenAI API key" }).click();
  await page.getByRole("menuitem", { name: "Rename label" }).click();
  await page.getByRole("dialog").getByLabel("Label").fill("Team");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  const renamed = page.getByRole("row", { name: "OpenAI · Team" });
  await expect(renamed).toBeVisible();

  await renamed.getByRole("button", { name: "Actions for OpenAI · Team" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No model providers yet")).toBeVisible();
});
