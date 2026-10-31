import { expect, type Page, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

import { gitServer } from "./servers.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 280;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

const REPO = `${gitServer}/acme/agent-skills.git`;
const LABEL = "localhost:4790/acme/agent-skills";

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  return new URL(page.url()).pathname.split("/")[2]!;
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

// Adds the fixture repository to the org from a pasted command; its skills arrive off.
async function addFromCommand(page: Page) {
  await page.goto("/org/skills");
  await page.getByRole("button", { name: "Add skills" }).click();
  await page.getByRole("menuitem", { name: "Add repository" }).click();
  const dialog = page.getByRole("dialog", { name: "Add repository" });
  await dialog.getByLabel("Repository").fill(`npx skills add ${REPO} --skill haiku`);
  await dialog.getByRole("button", { name: "Add repository" }).click();
  await expect(dialog).toBeHidden();
  const source = page.getByRole("region", { name: LABEL });
  await expect(source).toContainText("0 of 3 on");
  return source;
}

test("a repository added from a pasted command, a skill switched on, and loaded by the agent", async ({
  page,
}) => {
  const spaceId = await signUp(page);
  // A repository just added opens on its skills.
  const source = await addFromCommand(page);
  await source.getByRole("switch", { name: "haiku: on" }).click();
  await expect(source).toContainText("1 of 3 on");

  // A skill opens read-only with its files.
  await source.getByRole("listitem", { name: "haiku" }).getByRole("button").click();
  const preview = page.getByRole("dialog", { name: "haiku" });
  await expect(preview.getByLabel("SKILL.md")).toContainText("five, seven and five");
  await preview.getByRole("button", { name: "Close" }).first().click();

  await page.goto(`/s/${spaceId}/new`);
  await write(page, '/tool skills.load {"name":"haiku"}');
  await expect(
    transcript(page).getByRole("button", { name: /^Skills › Loaded haiku · Ran/ }),
  ).toBeVisible();
  await expect(transcript(page)).toContainText("Write three lines");

  await write(page, '/tool skills.load {"name":"release-notes"}');
  await expect(transcript(page)).toContainText("No skill named release-notes is on here");
});

test("a space switches an org repository off and on for itself", async ({ page }) => {
  const spaceId = await signUp(page);
  await addFromCommand(page);

  await page.goto(`/s/${spaceId}/settings/skills`);
  const source = page.getByRole("region", { name: LABEL });
  const here = source.getByRole("switch", { name: `${LABEL}: on in this space` });
  await expect(here).toBeChecked();
  await here.click();
  await expect(source).toContainText("Off here");
  await expect(here).not.toBeChecked();
  await here.click();
  await expect(source).toContainText("On here");
  // The org has its skills off: the space can't turn them on.
  await source.getByRole("button", { name: new RegExp(`^${LABEL}`) }).click();
  await expect(source.getByRole("switch", { name: "haiku: on in this space" })).toBeDisabled();
});

test("skills uploaded as a SKILL.md, a zip, and a file to finish by hand", async ({ page }) => {
  await signUp(page);
  await page.goto("/org/skills");
  const file = page.getByLabel("Skill file");
  await file.setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("---\nname: pirate\ndescription: Talk like a pirate\n---\nArr."),
  });
  const group = page.getByRole("region", { name: "Written and uploaded" });
  await expect(group).toContainText("1 of 1 on");

  await file.setInputFiles({
    name: "pack.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      zipSync({
        "pack/one/SKILL.md": strToU8("---\nname: one\ndescription: First\n---\n1"),
        "pack/two/SKILL.md": strToU8("---\nname: two\ndescription: Second\n---\n2"),
        "pack/two/notes.md": strToU8("Notes for two"),
      }),
    ),
  });
  await expect(group).toContainText("1 of 3 on");
  await group.getByRole("button", { name: /^Written and uploaded/ }).click();
  await group.getByRole("listitem", { name: "two" }).getByRole("button").click();
  const two = page.getByRole("dialog", { name: "two" });
  await two.getByRole("button", { name: "1 file" }).click();
  await page.getByRole("tab", { name: "notes.md" }).click();
  await expect(page.getByLabel("notes.md")).toContainText("Notes for two");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await file.setInputFiles({
    name: "Haiku.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("Five, seven, five."),
  });
  const draft = page.getByRole("dialog", { name: "New skill" });
  await expect(draft.getByLabel("Name")).toHaveValue("haiku");
  await expect(draft.getByLabel("SKILL.md")).toHaveValue("Five, seven, five.");
  await draft.getByLabel("Description").fill("Answer in a haiku");
  await draft.getByRole("button", { name: "Create skill" }).click();
  await expect(group).toContainText("2 of 4 on");
});
