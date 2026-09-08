/**
 * Name blinding, and the honesty about how well it works.
 *
 * The blind condition exists to separate two things a good score could mean: the model
 * reasoned from the evidence, or the model recognised the package and recalled what
 * happened to it. Remove the identifier and the second channel narrows.
 *
 * It does not close. An adversarial review of this design put the objection precisely,
 * and it is measured rather than argued with: a README is a verbatim document from the
 * training corpus, mirrored across npm, GitHub and hundreds of aggregators. Blinding the
 * name inside a document a model has memorised makes the retrieval key noisier, not
 * absent. Measured on the real point-in-time tarballs, `debug@4.3.4`'s README contains
 * its own name 235 times and 129 of its 146 URLs embed it; the median across a sample of
 * 51 packages was 42 occurrences for cases and 12 for controls, minimum 1. Every README
 * names its package.
 *
 * Two consequences shape this module:
 *
 *   1. Substitution, not redaction. `[REDACTED]` announces that something was removed and
 *      invites the model to reason about the removal. A consistent plausible pseudonym
 *      leaves a document that reads normally. The pseudonym is derived from the real name
 *      by seeded hash, so it is stable across runs and reproducible by anyone.
 *
 *   2. Re-identification is a first-class measurement. `truthlag` asks the model, on the
 *      blinded text alone, which package it is looking at. That rate is reported beside
 *      the blind-arm AUC, and above roughly 20-30% the blind arm is nominal and must be
 *      described as such rather than as a control that worked.
 */

import { createHash } from "node:crypto";

/** Pseudonym vocabulary. Deliberately dull and plausible: nothing here should read as a
 *  placeholder, and nothing should collide with a real popular package. */
const HEADS = [
  "vireo", "calder", "murex", "quillon", "sablefish", "tarn", "orrery", "pellucid",
  "brindle", "cobbleworks", "dunlin", "espalier", "fathom", "gantry", "halyard",
  "isinglass", "jetsam", "kestrel", "lodestar", "mizzen", "nacelle", "outrigger",
];
const TAILS = [
  "kit", "core", "utils", "tools", "runtime", "helpers", "engine", "adapter",
  "bridge", "client", "parser", "loader", "stream", "store", "config",
];

function seeded(key: string, n: number): number {
  return createHash("sha256").update(`truthlag:blind:${key}`).digest().readUInt32BE(0) % n;
}

export interface Pseudonym {
  /** What the package is called in blinded text, in the same shape as the original. */
  full: string;
  /** Scope without the `@`, or null for an unscoped package. */
  scope: string | null;
  /** Name after the scope. */
  base: string;
}

export function pseudonymFor(pkgName: string): Pseudonym {
  const scoped = pkgName.startsWith("@");
  const realBase = scoped ? pkgName.slice(pkgName.indexOf("/") + 1) : pkgName;
  const base = `${HEADS[seeded(realBase, HEADS.length)]}-${TAILS[seeded(`${realBase}:t`, TAILS.length)]}`;
  if (!scoped) return { full: base, scope: null, base };
  const realScope = pkgName.slice(1, pkgName.indexOf("/"));
  const scope = HEADS[seeded(`${realScope}:s`, HEADS.length)]!;
  return { full: `@${scope}/${base}`, scope, base };
}

/** Case-insensitive literal, escaped. */
function lit(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

/**
 * Name variants a package refers to itself by. `dompurify` appears as `DOMPurify`,
 * `node-convict` as `convict`, and a hyphenated name appears camelCased in code samples.
 */
function variants(base: string): string[] {
  const parts = base.split(/[-_.]/).filter(Boolean);
  const camel = parts
    .map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join("");
  const pascal = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
  const snake = parts.join("_");
  const squashed = parts.join("");
  // Longest first, so `node-convict` is replaced before the `convict` inside it.
  return [...new Set([base, camel, pascal, snake, squashed])]
    .filter((v) => v.length >= 3)
    .sort((a, b) => b.length - a.length);
}

export interface BlindResult {
  text: string;
  /** How many substitutions were made. High is normal; zero is suspicious. */
  replacements: number;
  /**
   * Identifying strings still present after substitution. Not a failure by itself, but
   * the number that decides whether the blind arm can be described as blind.
   */
  residual: string[];
}

/**
 * Replaces the package's identity throughout, and then looks for what it missed.
 *
 * The residual pass is the point. It reports what survived rather than asserting that
 * nothing did, because the substitutions above are a best effort against a document
 * written by someone with no interest in being anonymised.
 */
export function blind(
  text: string,
  pkgName: string,
  repoUrl?: string | null,
  pseudonym = pseudonymFor(pkgName),
): BlindResult {
  const scoped = pkgName.startsWith("@");
  const realScope = scoped ? pkgName.slice(1, pkgName.indexOf("/")) : null;
  const realBase = scoped ? pkgName.slice(pkgName.indexOf("/") + 1) : pkgName;

  let out = text;
  let replacements = 0;
  const sub = (re: RegExp, to: string): void => {
    out = out.replace(re, () => {
      replacements++;
      return to;
    });
  };

  // Full scoped name first: `@scope/name` must not become `@scope/pseudo`.
  if (scoped) sub(lit(pkgName), pseudonym.full);

  // A repository slug is an identifier the name alone does not cover: `debug-js/debug`,
  // `mozilla/node-convict`, `markedjs/marked`.
  if (repoUrl) {
    const slug = repoUrl.match(/(?:github\.com[/:])([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:$|[/#?])/i);
    if (slug) {
      const [, org, repo] = slug;
      sub(lit(`${org}/${repo}`), `${pseudonym.scope ?? "acme"}/${pseudonym.base}`);
      if (org && org.length >= 3) sub(lit(org), pseudonym.scope ?? "acme");
      if (repo && repo.length >= 3 && repo.toLowerCase() !== realBase.toLowerCase()) {
        sub(lit(repo), pseudonym.base);
      }
    }
  }

  for (const v of variants(realBase)) sub(lit(v), pseudonym.base);
  if (realScope && realScope.length >= 2) sub(lit(realScope), pseudonym.scope ?? "acme");

  // Bare domains built from the name survive the substitutions above once the name part
  // is gone (`marked.js.org` becomes `<pseudo>.js.org`), which is fine. What does not
  // survive scrutiny is an author email, a unique key that no substitution rule reaches.
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => {
    replacements++;
    return `maintainer@${pseudonym.base}.example`;
  });

  // A copyright line names a person, and a person names the package.
  //
  // Found by the re-identification probe rather than by reasoning about it: asked to
  // identify a blinded README, the model returned `marked` with confidence 1.0 and gave
  // its clue verbatim as "Copyright (c) 2011-2022, Christopher Jeffrey. (MIT License)".
  // package.json's `author` was already stripped; the licence block in the README was
  // not. This is what the probe is for, and leaving the hole open once it has been
  // pointed at would make the probe decorative.
  out = out.replace(
    /(copyright\s*(?:\(c\)|©|&copy;)?\s*)([0-9]{4}(?:\s*[-–]\s*(?:[0-9]{4}|present))?)([^\n]*)/gi,
    (_m, head: string, years: string) => {
      replacements++;
      return `${head}${years} the maintainers`;
    },
  );

  // What survived. Case-insensitive, and only reported when it is genuinely the name
  // rather than an English word that happens to match.
  const residual: string[] = [];
  const check = [pkgName, realBase, ...(realScope ? [realScope] : [])];
  for (const c of check) {
    if (c.length >= 4 && lit(c).test(out)) residual.push(c);
  }
  return { text: out, replacements, residual };
}

/** The prompt for the re-identification probe: no rubric, no risk question, just the ask. */
export const REIDENTIFY_PROMPT = `Below is the README and package.json of an npm package,
with its name and repository replaced by placeholders.

Name the real package if you recognise it. Do not guess from the general subject matter;
answer only if specific wording, API names, or structure identify it to you.

Return strict JSON and nothing else:

{"identified": <boolean>, "package": "<npm package name, or empty>", "confidence": <0.0-1.0>, "clue": "<the specific text that gave it away, verbatim, or empty>"}`;
