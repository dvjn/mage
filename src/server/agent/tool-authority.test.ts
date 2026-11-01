import { describe, expect, it } from "vite-plus/test";

import { EDITORS } from "@/shared/tools.ts";

import {
  type Approval,
  decide,
  type Decision,
  holds,
  type Influence,
  latestAuthor,
  mayAnswer,
  mayApprove,
  NOBODY,
  OPEN,
  personOf,
  type Rule,
  ruleFor,
  riskOf,
  stillPosts,
  type ToolRule,
  usesTool,
} from "./tool-authority.ts";

// The model, case by case. Ada and Grace may use the tool; Alan can post but may not use it;
// Vera lost her access to the thread.
const user = (
  seq: number,
  userId: string,
  { canPost = true, canUse = true }: Partial<Influence> = {},
): Influence => ({ seq, userId, canPost, canUse });
const ada = (seq: number) => user(seq, "ada");
const grace = (seq: number) => user(seq, "grace");
const alan = (seq: number) => user(seq, "alan", { canUse: false });
const vera = (seq: number) => user(seq, "vera", { canPost: false, canUse: false });

const open = ruleFor([OPEN]);
const rule = (fields: Partial<Rule>): ToolRule => ruleFor([{ ...NOBODY, ...fields }]);
const vouch = (atSeq: number, by = "grace", fields: Partial<Approval> = {}): Approval => ({
  atSeq,
  by,
  eligible: true,
  callId: "call-1",
  ...fields,
});
const connected =
  (...ids: string[]) =>
  (userId: string) =>
    ids.includes(userId);

type Input = Parameters<typeof decide>[0];
const call = (fields: Partial<Input>): Input => ({
  declared: "normal",
  rule: open,
  influence: [ada(1)],
  standing: [],
  ...fields,
});

describe("a call runs on its own when everyone who steered it could run the tool", () => {
  const cases: [string, Input, Decision][] = [
    ["a solo writer", call({ influence: [ada(1), ada(3)] }), { kind: "run" }],
    [
      "a group where all may use the tool",
      call({ influence: [ada(1), grace(2)] }),
      { kind: "run" },
    ],
    ["a group with someone who may not", call({ influence: [ada(1), alan(2)] }), { kind: "wait" }],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(decide(input)).toEqual(expected);
  });
});

describe("otherwise an approver vouches for it, once or for now", () => {
  it("once vs for now", () => {
    // A vouch once decides one call and leaves the next to wait; one for now covers it.
    const steered = [ada(1), alan(2)];
    expect(decide(call({ influence: steered }))).toEqual({ kind: "wait" });
    expect(decide(call({ influence: steered, standing: [vouch(5)] }))).toEqual({
      kind: "standing",
      callId: "call-1",
    });
  });

  const cases: [string, Input, Decision["kind"]][] = [
    [
      "for now ended by a new writer who may not use the tool",
      call({ influence: [ada(1), alan(2), alan(6)], standing: [vouch(5)] }),
      "wait",
    ],
    [
      "for now kept by a new writer who may use the tool",
      call({ influence: [ada(1), alan(2), grace(6)], standing: [vouch(5)] }),
      "standing",
    ],
    [
      "for now ended when its giver may no longer approve",
      call({ influence: [alan(2)], standing: [vouch(5, "grace", { eligible: false })] }),
      "wait",
    ],
    [
      "the latest vouch for now that holds decides",
      call({ influence: [alan(2), alan(6)], standing: [vouch(5), vouch(7, "ada")] }),
      "standing",
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(decide(input).kind).toBe(expected);
  });
});

describe("strictness", () => {
  const nobody = rule({ use: "none", approvers: [EDITORS] });
  const review = rule({
    use: "some",
    users: ["user:ada"],
    approvers: [EDITORS],
    independent: true,
  });

  const cases: [string, Input, Decision["kind"]][] = [
    ["ask: a solo writer waits", call({ declared: "ask" }), "wait"],
    ["ask: a vouch for now does not hold", call({ declared: "ask", standing: [vouch(0)] }), "wait"],
    [
      "a policy that lets nobody use the tool makes every call wait",
      call({ rule: nobody }),
      "wait",
    ],
    [
      "a policy that lets nobody use the tool ignores a vouch for now",
      call({ rule: nobody, standing: [vouch(0)] }),
      "wait",
    ],
    ["review: a solo writer waits", call({ declared: "review" }), "wait"],
    [
      "review: a vouch for now does not hold",
      call({ declared: "review", standing: [vouch(0)] }),
      "wait",
    ],
    [
      "review from a rule: a vouch for now does not hold",
      call({ rule: review, influence: [alan(1)], standing: [vouch(0)] }),
      "wait",
    ],
    [
      "review from a rule: even the tool's own users wait for a reviewer",
      call({ rule: review, influence: [ada(1)] }),
      "wait",
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(decide(input).kind).toBe(expected);
  });

  it("raises a tool's strictness from its rule", () => {
    expect(riskOf("normal", open)).toBe("normal");
    expect(riskOf("normal", nobody)).toBe("ask");
    expect(riskOf("normal", review)).toBe("review");
    expect(riskOf("ask", review)).toBe("review");
  });

  it("review: the approver can't be the latest writer", () => {
    const grace = personOf("grace", true, []);
    expect(mayApprove(grace, review, "review", "grace")).toBe(false);
    expect(mayApprove(grace, review, "review", "ada")).toBe(true);
    expect(mayApprove(grace, review, "ask", "grace")).toBe(true);
  });

  it("a policy that lets nobody use the tool still names its approvers", () => {
    const posts = personOf("alan", true, []);
    const viewer = personOf("vera", false, []);
    expect(mayApprove(posts, nobody, "ask", null)).toBe(true);
    expect(mayApprove(viewer, nobody, "ask", null)).toBe(false);
    expect(mayApprove(posts, ruleFor([NOBODY]), "ask", null)).toBe(false);
  });
});

describe("a vouch once lasts only while the thread does not change", () => {
  // What `approvalHolds` and `answerHolds` check just before an approved call runs.
  const cases: [string, Influence[], boolean][] = [
    ["a once vouch surviving a later writer who can post", [ada(1), alan(6)], true],
    ["a once vouch dropped by a writer who lost access", [ada(1), vera(6)], false],
    ["words before the vouch are already weighed", [vera(1)], true],
  ];
  it.each(cases)("%s", (_name, influence, expected) => {
    expect(holds(vouch(5), influence, stillPosts)).toBe(expected);
    // Whereas a vouch for now ends with any later writer who may not use the tool.
    expect(holds(vouch(5), influence, usesTool)).toBe(
      influence.every((words) => words.seq <= 5 || words.canUse),
    );
    // And no vouch outlives its giver's right to approve.
    expect(holds(vouch(5, "grace", { eligible: false }), influence, stillPosts)).toBe(false);
  });
});

describe("a personal-login tool asks whose login", () => {
  const cases: [string, Input, Decision][] = [
    [
      "solo connected: runs as them",
      call({ influence: [ada(1), ada(3)], connected: connected("ada") }),
      { kind: "run", runAs: "ada" },
    ],
    ["solo not connected", call({ influence: [ada(1)], connected: connected() }), { kind: "wait" }],
    [
      "group: waits even when all may use the tool",
      call({ influence: [ada(1), grace(2)], connected: connected("ada", "grace") }),
      { kind: "wait" },
    ],
    [
      "nobody's words: nobody to run as",
      call({ influence: [], connected: connected("ada") }),
      { kind: "wait" },
    ],
    [
      "for now: runs as the approver",
      call({ influence: [ada(1), grace(2)], standing: [vouch(5)], connected: connected("grace") }),
      { kind: "standing", callId: "call-1", runAs: "grace" },
    ],
    [
      "for now kept by the giver writing again",
      call({
        influence: [ada(1), grace(2), grace(7)],
        standing: [vouch(5)],
        connected: connected("grace"),
      }),
      { kind: "standing", callId: "call-1", runAs: "grace" },
    ],
    [
      "for now ended by anyone else writing, even someone who may use the tool",
      call({
        influence: [ada(1), grace(2), ada(7)],
        standing: [vouch(5)],
        connected: connected("grace", "ada"),
      }),
      { kind: "wait" },
    ],
    [
      "for now ended by the giver's login breaking",
      call({ influence: [ada(1), grace(2)], standing: [vouch(5)], connected: connected("ada") }),
      { kind: "wait" },
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(decide(input)).toEqual(expected);
  });
});

describe("questions and answers count as words", () => {
  const rows = [
    { kind: "human", seq: 1, author: { userId: "ada" } },
    { kind: "agent", seq: 2 },
    {
      kind: "tool",
      seq: 3,
      answers: { "Which?": "A" },
      decision: { by: { userId: "grace" }, seq: 4 },
    },
  ];

  it("an answer is its writer's words, where it was given", () => {
    expect(latestAuthor(rows)).toBe("grace");
    expect(latestAuthor([...rows, { kind: "human", seq: 5, author: { userId: "ada" } }])).toBe(
      "ada",
    );
    // A call that asked and was skipped is nobody's words.
    expect(latestAuthor([rows[0]!, { ...rows[2]!, answers: undefined }])).toBe("ada");
  });

  it("anyone who may use or approve the tool answers; nobody else", () => {
    const limited = rule({ use: "some", users: ["user:ada"], approvers: ["user:grace"] });
    expect(mayAnswer(personOf("ada", true, []), limited, "normal", null)).toBe(true);
    expect(mayAnswer(personOf("grace", true, []), limited, "normal", null)).toBe(true);
    expect(mayAnswer(personOf("alan", true, []), limited, "normal", null)).toBe(false);
    expect(mayAnswer(personOf("ada", false, []), limited, "normal", null)).toBe(false);
  });
});
