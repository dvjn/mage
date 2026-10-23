import { describe, expect, it } from "vite-plus/test";

import { orgSubtitle } from "@/shared/me.ts";

const personal = {
  id: "o1",
  name: "Ada Lovelace",
  kind: "personal" as const,
  ownerName: "Ada King",
};

describe("how the switcher names an org", () => {
  it("is Personal for the person's own personal org, and the owner's for someone else's", () => {
    expect(orgSubtitle({ org: personal, role: "owner" })).toBe("Personal");
    expect(orgSubtitle({ org: personal, role: "member" })).toBe("Ada King's Personal");
  });

  it("is a team org's name", () => {
    expect(orgSubtitle({ org: { ...personal, kind: "team", name: "Acme" }, role: "member" })).toBe(
      "Acme",
    );
  });
});
