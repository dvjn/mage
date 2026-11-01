import { expect, type Page, test } from "@playwright/test";

import { passwordServer } from "./servers.ts";

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
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Personal Space");
  await expect(page.getByRole("button", { name: "Switch space" })).toContainText("Personal");
});

test("with an identity provider there is no password sign-in or sign-up", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Continue with Test IdP" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create account" })).toHaveCount(0);
  await page.goto("/signup");
  await expect(page).toHaveURL("/login");
});

test("the identity provider signs someone in to the account they made with a password", async ({
  page,
}) => {
  // Ada made her account while the server took passwords.
  const email = uniqueEmail();
  await page.goto(`${passwordServer}/signup`);
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(inASpace);
  const space = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${passwordServer}/login`);

  // The provider knows her by another name; the account keeps hers.
  await continueWithIdp(page, "Augusta Ada King", email.toUpperCase());
  await expect(page).toHaveURL(space);
  await expect(page.getByRole("button", { name: "Account menu" })).toContainText("Ada Lovelace");
});
