import { describe, expect, it } from "vite-plus/test";
import { findPrUrls, parsePrRef } from "../src/pr-ref";

describe("parsePrRef", () => {
  it.each([
    ["https://github.com/acme/demo/pull/12", { repo: "acme/demo", number: 12 }],
    ["  https://github.com/acme/demo/pull/12/files?diff=split#diff-abc ", { repo: "acme/demo", number: 12 }],
    ["http://www.github.com/acme/my-repo.js/pull/7", { repo: "acme/my-repo.js", number: 7 }],
    ["acme/demo#12", { repo: "acme/demo", number: 12 }],
    ["Acme_1/de.mo-x#999999999", { repo: "Acme_1/de.mo-x", number: 999999999 }],
  ])("accepts %s", (input, ref) => expect(parsePrRef(input)).toEqual(ref));

  it.each([
    "",
    "12",
    "#12",
    "acme/demo",
    "acme/demo#0",
    "acme/demo#-1",
    "acme/demo#1.5",
    "acme/demo#12abc",
    "acme/demo#1234567890", // beyond what a PR number can be
    "acme/demo/extra#12",
    "../demo#12",
    "acme/..#12",
    "./.#12",
    "acme demo#12",
    "https://github.com/acme/demo/issues/12",
    "https://github.com/acme/demo/pull/",
    "https://gitlab.com/acme/demo/pull/12",
    "https://github.com.evil.io/acme/demo/pull/12",
    "see https://github.com/acme/demo/pull/12",
    "https://github.com/acme/demo/pull/12 https://github.com/acme/demo/pull/13",
  ])("rejects %j", (input) => expect(parsePrRef(input)).toBeNull());
});

describe("findPrUrls", () => {
  it("finds distinct PR URLs in order, ignoring other links", () => {
    const text = [
      "Creating pull request for dork/x into main in acme/demo",
      "https://github.com/acme/demo/pull/5",
      "stack: https://github.com/acme/demo/pull/6, https://github.com/acme/other/pull/1.",
      "again https://github.com/acme/demo/pull/5/files and https://github.com/acme/demo/issues/9 and https://github.com/acme/demo/pull/x",
    ].join("\n");
    expect(findPrUrls(text)).toEqual([
      { repo: "acme/demo", number: 5 },
      { repo: "acme/demo", number: 6 },
      { repo: "acme/other", number: 1 },
    ]);
  });

  it("finds nothing in unrelated output", () => {
    expect(findPrUrls("")).toEqual([]);
    expect(findPrUrls("https://github.com/acme/demo/pull/")).toEqual([]);
  });
});
