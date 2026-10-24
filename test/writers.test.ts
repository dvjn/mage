import { describe, expect, it } from "vite-plus/test";

import { writerLine, writersInFull } from "@/web/lib/writers.ts";

const grace = { userId: "u-grace", name: "Grace Hopper", guest: false };
const ada = { userId: "u-ada", name: "Ada Lovelace", guest: false };
const hedy = { userId: "u-hedy", name: "Hedy Lamarr", guest: true };
const gone = { userId: "u-gone", name: "(former member)", guest: false };

describe("a thread row's writers", () => {
  it("names the one or two who wrote last by first name, then counts the rest", () => {
    expect(writerLine({ people: [grace], total: 1 })).toBe("Grace");
    expect(writerLine({ people: [grace, ada], total: 2 })).toBe("Grace, Ada");
    expect(writerLine({ people: [grace, ada, hedy], total: 3 })).toBe("Grace, Ada +1");
    expect(writerLine({ people: [grace, ada, hedy], total: 5 })).toBe("Grace, Ada +3");
  });

  it("calls whoever is signed in You", () => {
    expect(writerLine({ people: [grace, ada], total: 2 }, "u-ada")).toBe("Grace, You");
    expect(writerLine({ people: [ada], total: 1 }, "u-ada")).toBe("You");
  });

  it("keeps a former member's name whole", () => {
    expect(writerLine({ people: [gone, grace], total: 2 })).toBe("(former member), Grace");
  });

  it("says nothing while nobody has written", () => {
    expect(writerLine({ people: [], total: 0 })).toBeNull();
    expect(writersInFull({ people: [], total: 0 })).toBeNull();
  });

  it("names everyone in full on hover, a guest marked, then how many more", () => {
    expect(writersInFull({ people: [hedy, ada], total: 2 })).toBe(
      "Hedy Lamarr (guest) and Ada Lovelace",
    );
    expect(writersInFull({ people: [grace, ada, hedy], total: 5 })).toBe(
      "Grace Hopper, Ada Lovelace, Hedy Lamarr (guest), and 2 more",
    );
  });
});
