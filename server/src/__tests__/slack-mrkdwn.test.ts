import { describe, it, expect } from "vitest";
import { fromGfm, toGfm } from "../messaging/adapters/slack/mrkdwn.js";

describe("GFM → mrkdwn", () => {
  it("translates bold", () => {
    expect(fromGfm("**hello**")).toBe("*hello*");
  });

  it("translates italic (asterisks)", () => {
    expect(fromGfm("*hello*")).toBe("_hello_");
  });

  it("translates links", () => {
    expect(fromGfm("[text](https://x.io)")).toBe("<https://x.io|text>");
  });

  it("preserves fenced code but drops language", () => {
    expect(fromGfm("```ts\nconst a = 1;\n```")).toBe("```\nconst a = 1;\n```");
  });

  it("translates unordered lists to bullets", () => {
    expect(fromGfm("- one\n- two")).toBe("• one\n• two");
    expect(fromGfm("* apple\n* banana")).toBe("• apple\n• banana");
  });

  it("translates task lists", () => {
    expect(fromGfm("- [ ] todo\n- [x] done")).toBe("☐ todo\n☑ done");
  });
});

describe("mrkdwn → GFM", () => {
  it("translates links back", () => {
    expect(toGfm("<https://x.io|text>")).toBe("[text](https://x.io)");
  });

  it("unwraps bare URLs in brackets", () => {
    expect(toGfm("<https://x.io>")).toBe("https://x.io");
  });

  it("translates bold back to GFM", () => {
    expect(toGfm("*hello*")).toBe("**hello**");
  });

  it("translates bullets back", () => {
    expect(toGfm("• one\n• two")).toBe("- one\n- two");
  });

  it("translates task glyphs back", () => {
    expect(toGfm("☐ todo\n☑ done")).toBe("- [ ] todo\n- [x] done");
  });
});

describe("round-trip", () => {
  const cases = [
    "**bold** and more",
    "- one\n- two\n- three",
    "- [ ] alpha\n- [x] beta",
    "see [docs](https://example.com/docs)",
  ];
  for (const input of cases) {
    it(`stabilises: ${input.slice(0, 30)}`, () => {
      const out = toGfm(fromGfm(input));
      expect(out).toBe(input);
    });
  }
});
