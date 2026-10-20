import { expect, type Page, test } from "@playwright/test";

const password = "correct horse battery";
// Signed-in people land in a space.
const inASpace = /\/s\/[^/]+$/;

function uniqueEmail() {
  return `${crypto.randomUUID()}@example.com`;
}

async function signUp(page: Page, name: string, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Full Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(inASpace);
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
}

test("signed out, home redirects to login, which links to signup", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page).toHaveURL("/signup");
});

test("signing up lands in Your space in the personal org and keeps the session", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace", uniqueEmail());
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await expect(sidebar.getByText("Ada Lovelace").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toContainText("Ada Lovelace");
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Your space");

  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Your space");

  await page.goto("/login");
  await expect(page).toHaveURL(url);
  await page.goto("/signup");
  await expect(page).toHaveURL(url);
});

test("signing out returns to login and guards home again", async ({ page }) => {
  await signUp(page, "Grace Hopper", uniqueEmail());
  await signOut(page);
  await page.goto("/");
  await expect(page).toHaveURL("/login");
});

test("signing in shows the server's error, then lands in a space", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, "Alan Turing", email);
  await signOut(page);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong password");
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST"),
    page.getByRole("button", { name: "Login" }).click(),
  ]);
  expect(response.ok()).toBe(false);
  const { message } = (await response.json()) as { message: string };
  expect(message).toBeTruthy();
  await expect(page.getByRole("alert")).toHaveText(message);
  await expect(page).toHaveURL("/login");

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).toHaveURL(inASpace);
  await expect(page.getByRole("button", { name: "Account menu" })).toContainText("Alan Turing");
});

test("mismatched passwords are caught before any request", async ({ page }) => {
  await page.goto("/signup");
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST") posts.push(req.url());
  });

  await page.getByLabel("Full Name").fill("Edsger Dijkstra");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill("something else");
  await page.getByRole("button", { name: "Create Account" }).click();

  await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
  await expect(page).toHaveURL("/signup");
  expect(posts).toEqual([]);
});
