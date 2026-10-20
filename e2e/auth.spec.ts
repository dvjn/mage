import { expect, type Page, test } from "@playwright/test";

const password = "correct horse battery";

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
  await expect(page).toHaveURL("/");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
}

test("signed out, home redirects to login, which links to signup", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page).toHaveURL("/signup");
});

test("signing up lands on home and keeps the session", async ({ page }) => {
  await signUp(page, "Ada Lovelace", uniqueEmail());
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page.getByText("Mage", { exact: true })).toBeVisible();
  await expect(page.getByText("API: ok")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Ada Lovelace")).toBeVisible();

  await page.goto("/login");
  await expect(page).toHaveURL("/");
  await page.goto("/signup");
  await expect(page).toHaveURL("/");
});

test("signing out returns to login and guards home again", async ({ page }) => {
  await signUp(page, "Grace Hopper", uniqueEmail());
  await signOut(page);
  await page.goto("/");
  await expect(page).toHaveURL("/login");
});

test("signing in shows the server's error, then lands on home", async ({ page }) => {
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
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Alan Turing")).toBeVisible();
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
