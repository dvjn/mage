import { describe, expect, it } from "vite-plus/test";

import { fenced, payloadOf, sizeText } from "./notification-details.ts";

describe("payloadOf", () => {
  it("pretty-prints JSON after the content type line", () => {
    const row = { last: 'Content-Type: application/json\n\n{"ref":"main"}' };
    expect(payloadOf(row)).toEqual({
      text: '{\n  "ref": "main"\n}',
      language: "json",
      contentType: "application/json",
    });
  });

  it("keeps other text as it came, with what the delivery says it was", () => {
    const row = {
      last: "plain words",
      delivery: { contentType: "text/plain", bytes: 11, signed: true },
    };
    expect(payloadOf(row)).toEqual({
      text: "plain words",
      language: "text",
      contentType: "text/plain",
    });
  });
});

describe("fenced", () => {
  it("uses a fence longer than any backticks inside", () => {
    expect(fenced("a ``` b", "text")).toBe("````text\na ``` b\n````");
  });
});

describe("sizeText", () => {
  it("scales", () => {
    expect(sizeText(12)).toBe("12 B");
    expect(sizeText(2048)).toBe("2.0 KB");
  });
});
