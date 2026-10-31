import { zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import { instructionsFor } from "@/server/agent/context.ts";
import {
  LOAD_SKILL,
  type OrgSkillList,
  parseSkillSource,
  READ_SKILL_FILE,
  type SkillDetail,
  type SkillSourceSummary,
  type SkillSummary,
  type SkillUploadResult,
  type SkillRefresh,
  type SpaceSkillList,
} from "@/shared/skills.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { GIT_ORIGIN, gitFixtures, setup } from "@/server/testing/workspace.ts";

import { createZipReader, type ArchiveError } from "./zip.ts";
import { type Skill, type SkillSource, effectiveSkills, type SpaceSkills } from "./service.ts";
import { discoverSkills, readSkillFile } from "./discovery.ts";
import { commitTo, createRepo, GIT_TOKEN } from "../../../e2e/git-server.ts";

const AGENT_SKILLS = `${GIT_ORIGIN}/acme/agent-skills.git`;

describe("what people paste to add skills", () => {
  const read = (text: string) => parseSkillSource(text);

  it("reads owner/repo and GitHub addresses, with a branch and folder from /tree/", () => {
    const github = {
      url: "https://github.com/anthropics/skills.git",
      label: "anthropics/skills",
      ref: null,
      subpath: null,
    };
    expect(read("anthropics/skills")).toEqual(github);
    expect(read("github.com/anthropics/skills")).toEqual(github);
    expect(read("https://github.com/anthropics/skills")).toEqual(github);
    expect(read("https://github.com/anthropics/skills.git")).toEqual(github);
    expect(read("git@github.com:anthropics/skills.git")).toEqual(github);
    expect(read("https://github.com/anthropics/skills/tree/main/document-skills/pdf/")).toEqual({
      ...github,
      ref: "main",
      subpath: "document-skills/pdf",
    });
  });

  it("reads GitLab and other git addresses", () => {
    expect(read("https://gitlab.com/acme/tools/skills/-/tree/dev/agents")).toEqual({
      url: "https://gitlab.com/acme/tools/skills",
      label: "acme/tools/skills",
      ref: "dev",
      subpath: "agents",
    });
    expect(read("http://git.test/acme/agent-skills.git")).toEqual({
      url: "http://git.test/acme/agent-skills.git",
      label: "git.test/acme/agent-skills",
      ref: null,
      subpath: null,
    });
  });

  it("strips commands that add skills, whose --skill names are left out", () => {
    expect(read("npx skills add anthropics/skills --skill pdf --skill docx")).toMatchObject({
      label: "anthropics/skills",
    });
    expect(
      read("npx -y skills@latest add vercel-labs/agent-skills -s react,next -g"),
    ).toMatchObject({ label: "vercel-labs/agent-skills" });
    expect(read("pnpm dlx skills add --agent claude-code acme/skills --skill=one")).toMatchObject({
      label: "acme/skills",
    });
    expect(read("npx add-skill https://github.com/acme/skills")).toMatchObject({
      label: "acme/skills",
    });
    expect(read("bunx skills add http://git.test/acme/agent-skills.git --skill haiku")).toEqual({
      url: "http://git.test/acme/agent-skills.git",
      label: "git.test/acme/agent-skills",
      ref: null,
      subpath: null,
    });
  });

  it("refuses what is not a repository", () => {
    for (const text of ["", "hello there", "npx something else", "ftp://example.com/a/b", "a"]) {
      expect(read(text)).toEqual({ error: "Paste owner/repo, a git URL, or a skills add command" });
    }
  });
});

describe("finding skills", () => {
  it("reads a SKILL.md's frontmatter, folded descriptions and all", () => {
    expect(
      readSkillFile(
        "---\nname: Release Notes\ndescription: >\n  Write notes\n  well\n---\n# Body\n",
      ),
    ).toEqual({ name: "Release Notes", description: "Write notes well\n", body: "# Body" });
    expect(readSkillFile("No frontmatter")).toEqual({
      name: null,
      description: null,
      body: "No frontmatter",
    });
    expect(readSkillFile("---\n: [bad\n---\nBody")).toEqual({
      name: null,
      description: null,
      body: "Body",
    });
  });

  it("finds skills at the top, in skills/ and .claude/skills/, each with its own files", () => {
    const found = discoverSkills(
      [
        { path: "README.md", text: "# Repo" },
        { path: "skills/a/SKILL.md", text: "---\nname: Alpha Skill\ndescription: A\n---\nDo a" },
        { path: "skills/a/ref/guide.md", text: "guide" },
        { path: "skills/a/inner/SKILL.md", text: "---\ndescription: Inner\n---\nDo inner" },
        { path: "skills/a/inner/notes.md", text: "notes" },
        { path: ".claude/skills/b/SKILL.md", text: "# B\n\nUse b for bees" },
        { path: "a/b/c/d/e/SKILL.md", text: "too deep" },
      ],
      "repo",
    );
    expect(
      found.map(({ path, name, description, files }) => ({ path, name, description, files })),
    ).toEqual([
      {
        path: "skills/a",
        name: "alpha-skill",
        description: "A",
        files: [{ path: "ref/guide.md", text: "guide" }],
      },
      { path: ".claude/skills/b", name: "b", description: "Use b for bees", files: [] },
      {
        path: "skills/a/inner",
        name: "inner",
        description: "Inner",
        files: [{ path: "notes.md", text: "notes" }],
      },
    ]);
    expect(discoverSkills([{ path: "SKILL.md", text: "Top" }], "my-repo")[0]).toMatchObject({
      path: ".",
      name: "my-repo",
    });
  });
});

function skillOf(fields: Partial<Skill> & Pick<Skill, "id" | "name">): Skill {
  return {
    orgId: "org",
    spaceId: null,
    sourceId: null,
    path: null,
    description: "",
    body: "",
    files: [],
    enabled: true,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  };
}

function sourceOf(id: string, enabled = true): SkillSource {
  return {
    id,
    orgId: "org",
    spaceId: null,
    label: id,
    url: "",
    ref: null,
    resolvedRef: null,
    subpath: null,
    commit: "",
    fetchedAt: new Date(0),
    enabled,
    hasToken: false,
    createdBy: null,
    createdAt: new Date(0),
  };
}

describe("the skills on in a space", () => {
  const base: SpaceSkills = {
    orgSources: [sourceOf("org-src"), sourceOf("org-off", false)],
    orgSkills: [
      skillOf({ id: "o1", name: "review", sourceId: "org-src" }),
      skillOf({ id: "o2", name: "notes", sourceId: "org-src" }),
      skillOf({ id: "o3", name: "off", sourceId: "org-src", enabled: false }),
      skillOf({ id: "o4", name: "gone", sourceId: "org-off" }),
      skillOf({ id: "o5", name: "written" }),
    ],
    ownSources: [sourceOf("own-src")],
    ownSkills: [
      skillOf({ id: "s1", name: "review", sourceId: "own-src", spaceId: "space" }),
      skillOf({ id: "s2", name: "mine", spaceId: "space" }),
    ],
    sourceSwitches: new Map(),
    skillSwitches: new Map(),
    allowed: true,
  };
  const ids = (set: SpaceSkills) => effectiveSkills(set).map((skill) => skill.id);

  it("are the org's that are on, with the space's own replacing those of the same name", () => {
    expect(ids(base)).toEqual(["s2", "o2", "s1", "o5"]);
  });

  it("leave out what the space turned off, and its own when the org does not let it have any", () => {
    expect(ids({ ...base, skillSwitches: new Map([["o2", false]]) })).toEqual(["s2", "s1", "o5"]);
    expect(ids({ ...base, sourceSwitches: new Map([["org-src", false]]) })).toEqual([
      "s2",
      "s1",
      "o5",
    ]);
    expect(ids({ ...base, allowed: false })).toEqual(["o2", "o1", "o5"]);
  });

  it("never take an org skill the org turned off, whatever the space set", () => {
    expect(
      ids({
        ...base,
        skillSwitches: new Map([
          ["o3", true],
          ["o4", true],
        ]),
        sourceSwitches: new Map([["org-off", true]]),
      }),
    ).not.toEqual(expect.arrayContaining(["o3"]));
  });
});

describe("the system prompt", () => {
  it("lists the skills after the instructions", () => {
    const prompt = instructionsFor(["Ada"], {
      org: "Be brief.",
      space: "Use British spelling.",
      skills: [{ name: "release-notes", description: "Write release notes" }],
    });
    expect(prompt.indexOf("- release-notes: Write release notes")).toBeGreaterThan(
      prompt.indexOf("British"),
    );
  });
});

async function json<T>(res: Response, status = 200) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

// Ada owns a team org with a shared space, where Grace is a member who manages nothing.
async function team() {
  const workspace = setup();
  const { api, signUp, join } = workspace;
  const ada = await signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const grace = join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");
  // Adds the repository, then turns on the skills named.
  async function add(scope: string, input: string, on: string[] = [], cookie = ada.cookie) {
    const res = await api("POST", `${scope}/skill-sources`, cookie, { input });
    if (!res.ok) return res;
    const source = (await res.clone().json()) as SkillSourceSummary;
    for (const name of on) {
      const skill = source.skills.find((candidate) => candidate.name === name)!;
      await json(await api("PUT", `/skills/${skill.id}/enabled`, cookie, { enabled: true }));
    }
    // The source as it is now, as the add answered it.
    const read = await api("GET", `${scope}/skills`, cookie);
    const agent = (await read.json()) as OrgSkillList & SpaceSkillList;
    const now = (scope === "/org" ? agent.sources : agent.own.sources).find(
      (one) => one.id === source.id,
    );
    return Response.json(now);
  }
  return { ...workspace, ada, grace, space, add };
}

describe("skill sources", () => {
  it("add a whole repository, every skill off, and refuse a second one of a name on", async () => {
    const { api, ada, add } = await team();
    const source = await json<SkillSourceSummary>(
      await api("POST", "/org/skill-sources", ada.cookie, {
        input: `npx skills add ${AGENT_SKILLS} --skill haiku`,
      }),
    );
    expect(source).toMatchObject({ label: "git.test/acme/agent-skills", resolvedRef: "main" });
    expect(
      source.skills.map((skill) => [skill.name, skill.path, skill.fileCount, skill.enabled]),
    ).toEqual([
      ["code-review", "skills/code-review", 1, false],
      ["haiku", ".claude/skills/haiku", 0, false],
      ["release-notes", "skills/release-notes", 1, false],
    ]);
    const second = await json<SkillSourceSummary>(await add("/org", AGENT_SKILLS, ["haiku"]));
    const first = source.skills.find((skill) => skill.name === "haiku")!;
    const clash = await api("PUT", `/skills/${first.id}/enabled`, ada.cookie, { enabled: true });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ error: "A skill named haiku is already on" });
    // Turning the first source's other skills on is fine; turning the second off frees the name.
    await json(
      await api("PUT", `/skill-sources/${second.id}/enabled`, ada.cookie, { enabled: false }),
    );
    await json(await api("PUT", `/skills/${first.id}/enabled`, ada.cookie, { enabled: true }));
    const back = await api("PUT", `/skill-sources/${second.id}/enabled`, ada.cookie, {
      enabled: true,
    });
    expect(back.status).toBe(409);
  });

  it("say why a repository can't be read, and read a private one with its token", async () => {
    const { api, ada } = await team();
    const add = (input: string, token?: string) =>
      api("POST", "/org/skill-sources", ada.cookie, { input, token });
    expect(await json(await add(`${GIT_ORIGIN}/acme/no-skills.git`), 400)).toEqual({
      error: "No SKILL.md found in this repository",
      reason: "no_skills",
    });
    expect(await json(await add(`${GIT_ORIGIN}/private/team-skills.git`), 400)).toEqual({
      error: "This repository needs a token",
      reason: "auth",
    });
    expect(await json(await add("not a repo"), 400)).toEqual({
      error: "Paste owner/repo, a git URL, or a skills add command",
    });
    const source = await json<SkillSourceSummary>(
      await add(`${GIT_ORIGIN}/private/team-skills.git`, GIT_TOKEN),
    );
    expect(source.skills.map((skill) => skill.name)).toEqual(["standup"]);
    expect(source.hasToken).toBe(true);
    expect(JSON.stringify(source)).not.toContain(GIT_TOKEN);
    // A token that can't read it is refused and the old one kept.
    expect(
      (await api("PUT", `/skill-sources/${source.id}/token`, ada.cookie, { token: "wrong" }))
        .status,
    ).toBe(400);
    const refreshed = await json<SkillRefresh>(
      await api("POST", `/skill-sources/${source.id}/refresh`, ada.cookie),
    );
    expect(refreshed).toMatchObject({ added: [], changed: [], removed: [] });
  });

  it("refresh at once: new skills arrive off, removed ones go, changed ones keep their switch", async () => {
    const { api, ada, add } = await team();
    // A repository of its own, so other tests' commits don't move it.
    const repo = `acme/updates-${crypto.randomUUID()}`;
    createRepo(gitFixtures(), repo, {
      "one/SKILL.md": "---\nname: one\ndescription: First\n---\nOne",
      "two/SKILL.md": "---\nname: two\ndescription: Second\n---\nTwo",
    });
    const source = await json<SkillSourceSummary>(
      await add("/org", `${GIT_ORIGIN}/${repo}.git`, ["one", "two"]),
    );
    const refresh = () =>
      api("POST", `/skill-sources/${source.id}/refresh`, ada.cookie).then((res) =>
        json<SkillRefresh>(res),
      );
    expect(await refresh()).toMatchObject({ added: [], changed: [], removed: [] });

    commitTo(gitFixtures(), repo, {
      "one/SKILL.md": "---\nname: one\ndescription: First, better\n---\nOne",
      "two/SKILL.md": null,
      "three/SKILL.md": "---\nname: three\ndescription: Third\n---\nThree",
    });
    const refreshed = await refresh();
    expect(refreshed).toMatchObject({ added: ["three"], changed: ["one"], removed: ["two"] });
    expect(refreshed.source.commit).not.toBe(source.commit);
    expect(
      refreshed.source.skills.map((skill) => [skill.name, skill.description, skill.enabled]),
    ).toEqual([
      ["one", "First, better", true],
      ["three", "Third", false],
    ]);
  });
});

describe("skills by scope", () => {
  it("are the org owners' to add in the org, and read by its members", async () => {
    const { api, ada, grace, add } = await team();
    expect((await add("/org", AGENT_SKILLS, [], grace.cookie)).status).toBe(403);
    await json(await api("GET", "/org/skills", grace.cookie, undefined, ada.orgId));
  });

  it("refuse a second skill of one name on in a scope, and written skills follow the same rule", async () => {
    const { api, ada } = await team();
    const written = await json<SkillSummary>(
      await api("POST", "/org/skills", ada.cookie, {
        name: "haiku",
        description: "Answer in haiku",
        body: "Three lines.",
      }),
    );
    const source = await json<SkillSourceSummary>(
      await api("POST", "/org/skill-sources", ada.cookie, { input: AGENT_SKILLS }),
    );
    const haiku = source.skills.find((skill) => skill.name === "haiku")!;
    const on = await api("PUT", `/skills/${haiku.id}/enabled`, ada.cookie, { enabled: true });
    expect(on.status).toBe(409);
    await json(await api("PUT", `/skills/${written.id}/enabled`, ada.cookie, { enabled: false }));
    await json(await api("PUT", `/skills/${haiku.id}/enabled`, ada.cookie, { enabled: true }));
    // Turned on again, the written one clashes; and a source's skill can't be edited.
    expect(
      (await api("PUT", `/skills/${written.id}/enabled`, ada.cookie, { enabled: true })).status,
    ).toBe(409);
    const edit = await api("PATCH", `/skills/${haiku.id}`, ada.cookie, {
      name: "haiku",
      description: "d",
      body: "b",
    });
    expect(edit.status).toBe(400);
    const detail = await json<SkillDetail>(await api("GET", `/skills/${haiku.id}`, ada.cookie));
    expect(detail.body).toContain("five, seven and five");
    expect(
      (
        await api("POST", "/org/skills", ada.cookie, {
          name: "Not Kebab",
          description: "d",
          body: "b",
        })
      ).status,
    ).toBe(400);
  });

  it("let a space turn the org's off for itself, never on while the org has it off", async () => {
    const { api, ada, space, add } = await team();
    const source = await json<SkillSourceSummary>(
      await add("/org", AGENT_SKILLS, ["release-notes", "haiku"]),
    );
    const [review, haiku] = source.skills;
    const read = () =>
      api("GET", `/spaces/${space.id}/skills`, ada.cookie).then((res) => json<SpaceSkillList>(res));
    // The org has code-review off: the space can't turn it on.
    const refused = await api("PUT", `/spaces/${space.id}/skills/${review!.id}`, ada.cookie, {
      enabled: true,
    });
    expect(refused.status).toBe(409);
    await json(
      await api("PUT", `/spaces/${space.id}/skills/${haiku!.id}`, ada.cookie, { enabled: false }),
    );
    expect((await read()).org.sources[0]!.skills.map((skill) => skill.inSpace)).toEqual([
      true,
      false,
      true,
    ]);
    // Off for the whole source here, none of its skills are on.
    await json(
      await api("PUT", `/spaces/${space.id}/skill-sources/${source.id}`, ada.cookie, {
        enabled: false,
      }),
    );
    expect((await read()).org.sources[0]!.inSpace).toBe(false);
  });

  it("keep a space's own skills while the org lets spaces add them", async () => {
    const { api, ada, space, add, skills, spaceStore } = await team();
    await json(
      await api("POST", `/spaces/${space.id}/skills`, ada.cookie, {
        name: "local",
        description: "Only here",
        body: "Local.",
      }),
    );
    const here = spaceStore.find(space.id)!;
    expect(skills.effectiveIn(here).map((skill) => skill.name)).toEqual(["local"]);
    await json(await api("PUT", "/org/skills/space-skills", ada.cookie, { allowed: false }));
    expect(skills.effectiveIn(here)).toEqual([]);
    expect((await add(`/spaces/${space.id}`, AGENT_SKILLS)).status).toBe(403);
  });
});

describe("the agent", () => {
  it("reads the instructions and skills in its prompt, and loads a skill and its files", async () => {
    const { ada, api, post, model, worker, start, events } = await agentThread();
    await json(await api("PUT", "/org/instructions", ada.cookie, { text: "Be brief." }));
    const source = await json<SkillSourceSummary>(
      await api("POST", "/org/skill-sources", ada.cookie, { input: AGENT_SKILLS }),
    );
    const notes = source.skills.find((skill) => skill.name === "release-notes")!;
    await json(await api("PUT", `/skills/${notes.id}/enabled`, ada.cookie, { enabled: true }));
    start();
    await post(ada, "Write the release notes");
    const first = await model.next();
    expect(first.request.instructions).toContain("Instructions from the organization:\nBe brief.");
    expect(first.request.instructions).toContain(
      "- release-notes: Write release notes from merged changes",
    );
    expect(first.tools).toEqual(expect.arrayContaining([LOAD_SKILL, READ_SKILL_FILE]));
    first.startStep();
    first.toolCall("c1", LOAD_SKILL, { name: "release-notes" });
    first.toolCall("c2", READ_SKILL_FILE, { name: "release-notes", path: "templates/notes.md" });
    first.toolCall("c3", LOAD_SKILL, { name: "haiku" });
    first.endStep();
    first.end();
    const next = await model.next();
    next.reply("Done.");
    await worker.idle();
    const results = next.texts.filter((text) => text.startsWith("result"));
    expect(results[0]).toContain('"instructions":"# Release notes');
    expect(results[0]).toContain('"files":["templates/notes.md"]');
    expect(results[1]).toContain("What's new");
    expect(results[2]).toContain(
      "No skill named haiku is on here. The skills here: release-notes.",
    );
    expect(events().filter((event) => event.type === "tool.ran")).toHaveLength(3);
  });
});

const encode = (text: string) => new TextEncoder().encode(text);

describe("the zip reader", () => {
  it("reads text files, leaving out folders, binaries, macOS forks and paths that climb out", () => {
    const zip = zipSync({
      "pack/": new Uint8Array(),
      "pack/a/SKILL.md": encode("---\nname: a\ndescription: A\n---\nDo a"),
      "pack/a/logo.png": new Uint8Array([0, 1, 2]),
      "__MACOSX/pack/a/._SKILL.md": encode("fork"),
      "../evil.md": encode("no"),
    });
    expect(createZipReader().files(zip)).toEqual([
      { path: "pack/a/SKILL.md", text: "---\nname: a\ndescription: A\n---\nDo a" },
    ]);
  });

  it("refuses what is not a zip, and one past its caps", () => {
    const failure = (run: () => unknown) => {
      try {
        run();
      } catch (err) {
        return err as ArchiveError;
      }
      throw new Error("no failure");
    };
    expect(failure(() => createZipReader().files(encode("hello"))).kind).toBe("invalid");
    const many = zipSync(Object.fromEntries([1, 2, 3].map((n) => [`f${n}.md`, encode("x")])));
    expect(failure(() => createZipReader({ maxFiles: 2 }).files(many)).kind).toBe("too_large");
    expect(failure(() => createZipReader({ maxEntries: 2 }).files(many)).kind).toBe("too_large");
    const big = zipSync({ "a.md": encode("x".repeat(3000)), "b.md": encode("y".repeat(3000)) });
    expect(failure(() => createZipReader({ maxBytes: 4000 }).files(big)).kind).toBe("too_large");
    // A file over its own cap is left out, not refused.
    expect(createZipReader({ maxFileBytes: 1000 }).files(big)).toEqual([]);
  });
});

describe("uploaded skills", () => {
  function upload(
    api: ReturnType<typeof setup>["api"],
    cookie: string,
    fileName: string,
    data: Uint8Array,
    scope = "/org",
  ) {
    return api("POST", `${scope}/skills/upload`, cookie, {
      fileName,
      data: Buffer.from(data).toString("base64"),
    });
  }

  it("add a SKILL.md that names itself as one written skill, on", async () => {
    const { api, ada } = await team();
    const result = await json<SkillUploadResult>(
      await upload(
        api,
        ada.cookie,
        "SKILL.md",
        encode("---\nname: Pirate Talk\ndescription: Talk\n  like a pirate\n---\nArr."),
      ),
    );
    expect(result).toMatchObject({
      status: "added",
      skills: [
        { name: "pirate-talk", description: "Talk like a pirate", sourceId: null, enabled: true },
      ],
    });
    const agent = await json<OrgSkillList>(await api("GET", "/org/skills", ada.cookie));
    expect(agent.written.map((skill) => skill.name)).toEqual(["pirate-talk"]);
  });

  it("give back a draft for a file that doesn't name or describe its skill", async () => {
    const { api, ada } = await team();
    expect(
      await json(
        await upload(api, ada.cookie, "Release Notes.md", encode("# Notes\n\nGroup by area.")),
      ),
    ).toEqual({
      status: "draft",
      draft: { name: "release-notes", description: "", body: "# Notes\n\nGroup by area." },
    });
    expect(
      await json(await upload(api, ada.cookie, "SKILL.md", encode("---\ndescription: D\n---\nB"))),
    ).toEqual({
      status: "draft",
      draft: { name: "", description: "D", body: "B" },
    });
  });

  it("read a zip as a repository: one skill comes on with its files, several come off", async () => {
    const { api, ada } = await team();
    const one = zipSync({
      "haiku/SKILL.md": encode("---\nname: haiku\ndescription: Haiku\n---\nFive, seven, five."),
      "haiku/examples.md": encode("An old silent pond"),
    });
    const single = await json<SkillUploadResult>(await upload(api, ada.cookie, "haiku.zip", one));
    expect(single).toMatchObject({
      status: "added",
      skills: [{ name: "haiku", enabled: true, fileCount: 1 }],
    });
    const id = single.status === "added" ? single.skills[0]!.id : "";
    const detail = await json<SkillDetail>(await api("GET", `/skills/${id}`, ada.cookie));
    expect(detail.files).toEqual([{ path: "examples.md", text: "An old silent pond" }]);
    // Uploaded skills are edited like written ones, keeping their files.
    await json(
      await api("PATCH", `/skills/${id}`, ada.cookie, {
        name: "haiku",
        description: "Haiku",
        body: "Better.",
      }),
    );
    expect(
      (await json<SkillDetail>(await api("GET", `/skills/${id}`, ada.cookie))).files,
    ).toHaveLength(1);

    const several = zipSync({
      "skills/one/SKILL.md": encode("---\nname: one\ndescription: One\n---\n1"),
      "skills/haiku/SKILL.md": encode("---\nname: haiku\ndescription: Another\n---\n2"),
    });
    const added = await json<SkillUploadResult>(await upload(api, ada.cookie, "pack.zip", several));
    expect(
      added.status === "added" && added.skills.map((skill) => [skill.name, skill.enabled]),
    ).toEqual([
      ["haiku", false],
      ["one", false],
    ]);
    expect(
      await json(await upload(api, ada.cookie, "empty.zip", zipSync({ "a.md": encode("x") })), 400),
    ).toEqual({
      error: "No SKILL.md found in this file",
      reason: "no_skills",
    });
    expect(
      (
        await json<{ reason: string }>(
          await upload(api, ada.cookie, "bad.zip", encode("nope")),
          400,
        )
      ).reason,
    ).toBe("invalid");
  });
});
