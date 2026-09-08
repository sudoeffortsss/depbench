import { describe, expect, it } from "vitest";
import { buildContent, type PackageText } from "./llm-input.js";
import { CONDITIONS } from "./prompts.js";

const spec = (k: string) => CONDITIONS.find((c) => c.key === k)!;

const pkg = (over: Partial<PackageText> = {}): PackageText => ({
  pkg_name: "marked",
  version: "4.2.5",
  readme: "# marked\n\nA markdown parser. See https://github.com/markedjs/marked",
  package_json: JSON.stringify({
    name: "marked",
    version: "4.2.5",
    repository: { type: "git", url: "https://github.com/markedjs/marked.git" },
    author: "Christopher Jeffrey",
    dependencies: { commander: "^9.0.0" },
    scripts: { test: "jest" },
  }),
  ...over,
});

describe("buildContent, named conditions", () => {
  it("shows the name and both documents", () => {
    const b = buildContent(pkg(), spec("practitioner-named"));
    expect(b.content).toContain("Package name: marked");
    expect(b.content).toContain("A markdown parser");
    expect(b.content).toContain("commander");
    expect(b.residual).toEqual([]);
  });

  it("does not include download counts or dates, which rules already measure", () => {
    const b = buildContent(pkg(), spec("practitioner-named"));
    expect(b.content).not.toMatch(/downloads?_prior_month|days_since_last_pub/);
  });
});

describe("buildContent, blind conditions", () => {
  it("removes the name from the prose", () => {
    const b = buildContent(pkg(), spec("practitioner-blind"));
    expect(b.content).not.toMatch(/\bmarked\b/i);
    expect(b.residual).toEqual([]);
  });

  it("removes the repository org, which identifies as surely as the name", () => {
    const b = buildContent(pkg(), spec("practitioner-blind"));
    expect(b.content).not.toMatch(/markedjs/i);
  });

  it("drops the identifying package.json fields rather than faking them", () => {
    // A plausible-but-wrong repository URL reads as real and invites reasoning about it.
    const b = buildContent(pkg(), spec("practitioner-blind"));
    expect(b.content).not.toContain('"repository"');
    expect(b.content).not.toContain('"author"');
    // The informative half survives.
    expect(b.content).toContain("commander");
  });

  it("says the fields were removed instead of passing the document off as genuine", () => {
    const b = buildContent(pkg(), spec("practitioner-blind"));
    expect(b.content).toMatch(/have been replaced|identifying fields removed/i);
  });

  it("keeps identifying keys out even when truncation broke the JSON", () => {
    const broken = '{"name":"marked","repository":{"url":"https://github.com/markedjs/mar';
    const b = buildContent(pkg({ package_json: broken }), spec("practitioner-blind"));
    expect(b.content).not.toMatch(/markedjs/i);
  });
});

describe("buildContent, evidence accounting", () => {
  it("flags a package with neither document, the abstention test case", () => {
    const b = buildContent(pkg({ readme: null, package_json: null }), spec("practitioner-named"));
    expect(b.evidenceEmpty).toBe(true);
    expect(b.content).toMatch(/ships no README/i);
  });

  it("does not flag a package that has package.json but no README", () => {
    // Thin evidence is not absent evidence, and conflating them would put a real
    // population into the wrong group.
    const b = buildContent(pkg({ readme: null }), spec("practitioner-named"));
    expect(b.evidenceEmpty).toBe(false);
  });
});

describe("buildContent, the recall probe", () => {
  it("is given the name and no text at all", () => {
    const b = buildContent(pkg(), spec("recall"));
    expect(b.content).toBe("npm package: marked");
    expect(b.content).not.toContain("markdown parser");
  });

  it("is never blinded, since the name is the whole question", () => {
    expect(spec("recall").blinded).toBe(false);
  });
});
