import { describe, expect, it } from "vitest";
import { blind, pseudonymFor } from "./blind.js";

describe("pseudonymFor", () => {
  it("is deterministic, so a blinded corpus is reproducible", () => {
    expect(pseudonymFor("lodash").full).toBe(pseudonymFor("lodash").full);
  });

  it("gives different packages different names", () => {
    expect(pseudonymFor("lodash").full).not.toBe(pseudonymFor("express").full);
  });

  it("keeps the shape: a scoped package stays scoped", () => {
    const p = pseudonymFor("@babel/traverse");
    expect(p.full.startsWith("@")).toBe(true);
    expect(p.full).toContain("/");
    expect(p.scope).not.toBeNull();
  });

  it("does not leak the real name into the pseudonym", () => {
    const p = pseudonymFor("@babel/traverse");
    expect(p.full.toLowerCase()).not.toContain("babel");
    expect(p.full.toLowerCase()).not.toContain("traverse");
  });

  it("reads as a package name rather than a placeholder", () => {
    // A model told the name was removed can reason about the removal; one shown a
    // plausible name has nothing to notice.
    expect(pseudonymFor("lodash").full).not.toMatch(/redact|anon|xxx|placeholder/i);
    expect(pseudonymFor("lodash").full).toMatch(/^[a-z][a-z-]+$/);
  });
});

describe("blind", () => {
  it("removes the plain name and reports no residual", () => {
    const r = blind("# lodash\n\nInstall with `npm i lodash`.", "lodash");
    expect(r.text).not.toMatch(/lodash/i);
    expect(r.residual).toEqual([]);
    expect(r.replacements).toBeGreaterThan(0);
  });

  it("removes both halves of a scoped name", () => {
    const r = blind("`npm i @babel/traverse` — see @babel/core too.", "@babel/traverse");
    expect(r.text).not.toMatch(/babel/i);
    expect(r.text).not.toMatch(/traverse/i);
    expect(r.residual).toEqual([]);
  });

  it("catches case variants a literal match would miss", () => {
    // DOMPurify's README calls it DOMPurify, not dompurify.
    const r = blind("DOMPurify sanitises HTML. Use dompurify from npm.", "dompurify");
    expect(r.text).not.toMatch(/dompurify/i);
  });

  it("catches the camelCase form of a hyphenated name", () => {
    const r = blind("import fastRedact from 'fast-redact'", "fast-redact");
    expect(r.text).not.toMatch(/fast-?redact/i);
  });

  it("removes a repository slug that is not the package name", () => {
    // `debug-js/debug` and `mozilla/node-convict` identify as surely as the name does.
    const r = blind(
      "Source at https://github.com/mozilla/node-convict — file issues there.",
      "convict",
      "git+https://github.com/mozilla/node-convict.git",
    );
    expect(r.text).not.toMatch(/mozilla/i);
    expect(r.text).not.toMatch(/node-convict/i);
  });

  it("replaces an author email, which no name rule reaches", () => {
    // mario@cure53.de is a unique key for DOMPurify.
    const r = blind("Maintained by mario@cure53.de", "dompurify");
    expect(r.text).not.toContain("cure53");
    expect(r.text).toMatch(/maintainer@[\w-]+\.example/);
  });

  it("reports residual rather than claiming success when the name survives", () => {
    // A name embedded inside a longer word is not substituted, and pretending otherwise
    // is the failure mode this field exists to prevent.
    const r = blind("See the xxmarkedxx internals.", "marked");
    // Whatever the substitution does, `residual` must agree with the text.
    const stillThere = /marked/i.test(r.text);
    expect(r.residual.length > 0).toBe(stillThere);
  });

  it("leaves unrelated prose alone", () => {
    const r = blind("A fast JSON parser for Node.js.", "quux-parser");
    expect(r.text).toContain("A fast JSON parser for Node.js.");
  });

  it("substitutes consistently, so the document still reads as one package", () => {
    const p = pseudonymFor("marked");
    const r = blind("marked is fast. Install marked. See marked docs.", "marked");
    expect(r.text.split(p.base).length - 1).toBe(3);
  });

  it("does not shorten the text into uselessness", () => {
    const src = "# marked\n\n".repeat(50);
    const r = blind(src, "marked");
    expect(r.text.length).toBeGreaterThan(src.length * 0.5);
  });
});

describe("blind, holes found by the re-identification probe", () => {
  it("removes the name in a copyright line", () => {
    // The probe returned `marked` at confidence 1.0 and named this exact line as its
    // clue. package.json's author was already stripped; the README licence block was not.
    const r = blind(
      "## License\n\nCopyright (c) 2011-2022, Christopher Jeffrey. (MIT License)",
      "marked",
    );
    expect(r.text).not.toContain("Christopher Jeffrey");
    expect(r.text).toMatch(/Copyright \(c\) 2011-2022 the maintainers/);
  });

  it("handles the single-year and present forms", () => {
    expect(blind("Copyright 2019 Someone Else", "x-pkg").text).not.toContain("Someone Else");
    expect(blind("Copyright (c) 2015-present Jane Doe", "x-pkg").text).not.toContain("Jane Doe");
  });

  it("leaves the word copyright alone in ordinary prose", () => {
    const r = blind("Respect the copyright of your dependencies.", "x-pkg");
    expect(r.text).toContain("Respect the copyright of your dependencies.");
  });
});
