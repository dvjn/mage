import { describe, expect, it } from "vite-plus/test";

import { SHORTCUTS, shortcutKeys, shortcutsByGroup } from "@/web/lib/shortcuts.ts";

describe("the shortcut registry", () => {
  it("lists every shortcut once, under its own group", () => {
    const listed = shortcutsByGroup().flatMap(({ group, shortcuts }) =>
      shortcuts.map((shortcut) => [shortcut.id, group]),
    );
    expect(listed).toEqual(
      Object.entries(SHORTCUTS)
        .map(([id, shortcut]) => [id, shortcut.group])
        .toSorted(
          (a, b) =>
            ["General", "Threads", "Composer"].indexOf(a[1]!) -
            ["General", "Threads", "Composer"].indexOf(b[1]!),
        ),
    );
  });

  it("writes a shortcut's keys as the system in use does", () => {
    expect(shortcutKeys("search", "mac")).toEqual(["⌘", "K"]);
    expect(shortcutKeys("newThread", "linux")).toEqual(["Ctrl", "O"]);
  });
});
