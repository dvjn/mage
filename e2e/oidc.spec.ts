import { expect, type Page, test } from "@playwright/test";

// Signed-in people land in a space.
const inASpace = /\/s\/[^/]+$/;

function uniqueEmail() {
  return `${crypto.randomUUID()}@example.com`;
}

// Signs in at the stand-in provider as the person with `email`.
async function continueWithIdp(page: Page, name: string, email: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Test IdP" }).click();
  await expect(page.getByRole("heading", { name: "Test IdP" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(inASpace);
}

test("continuing with the identity provider makes an account with its own space", async ({
  page,
}) => {
  const email = uniqueEmail();
  await continueWithIdp(page, "Grace Hopper", email);
  await expect(page.getByRole("button", { name: "Account menu" })).toContainText(email);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Grace Hopper's Space");
  await expect(page.getByRole("button", { name: "Switch space" })).toContainText("Personal");
});

test("the identity provider signs someone in to the account they made with a password", async ({
  page,
}) => {
  const email = uniqueEmail();
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(inASpace);
  const space = page.url();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");

  // The provider knows her by another name; the account keeps hers.
  await continueWithIdp(page, "Augusta Ada King", email.toUpperCase());
  await expect(page).toHaveURL(space);
  await expect(page.getByRole("button", { name: "Account menu" })).toContainText("Ada Lovelace");
});
