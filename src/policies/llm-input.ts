/**
 * Assembles what a model is shown, for one package under one condition.
 *
 * Two things this deliberately does not include, both because a rule policy already
 * measures them and re-serving them to a model would measure nothing new: download
 * counts and release dates. What is left is prose, which is the only input a model has
 * that a rule does not.
 *
 * The no-text case is not an inconvenience to route around. 13% of the universe ships no
 * README at all, and those packages are the cleanest possible test of the second thing
 * this arm measures: given material that objectively cannot support a judgement, does
 * the model decline, or does it produce a confident number anyway? A rule abstains
 * mechanically. Judgement about one's own evidence is the thing only a model can offer,
 * and the thing least often checked.
 */

import { blind, pseudonymFor } from "./blind.js";
import type { ConditionSpec } from "./prompts.js";

export interface PackageText {
  pkg_name: string;
  version: string;
  readme: string | null;
  package_json: string | null;
}

export interface BuiltContent {
  content: string;
  /** No README and no package.json: objectively nothing to judge on. */
  evidenceEmpty: boolean;
  /** Identifying strings that survived blinding, empty for unblinded conditions. */
  residual: string[];
  blindReplacements: number;
}

/** Fields that name the package regardless of the prose around them. */
const IDENTIFYING_PACKAGE_JSON_KEYS = [
  "name", "repository", "homepage", "bugs", "author", "contributors", "maintainers",
  "funding", "bin",
];

/**
 * package.json is filtered rather than blinded for the blind conditions.
 *
 * Substituting inside JSON produces a document that still announces its own structure —
 * a `repository.url` pointing at a plausible-but-wrong GitHub org reads as a real
 * repository and invites the model to reason about it. Dropping the identifying keys
 * outright is honest: the model is told the fields were removed, so nothing is being
 * passed off as genuine.
 */
function stripIdentity(packageJson: string): string {
  try {
    const o = JSON.parse(packageJson) as Record<string, unknown>;
    for (const k of IDENTIFYING_PACKAGE_JSON_KEYS) delete o[k];
    return JSON.stringify(o, null, 1);
  } catch {
    // Truncation at the character cap routinely leaves invalid JSON. Returning the text
    // unparsed would leak the name; returning nothing loses the dependency list, which
    // is the informative part. Keep the lines that carry no identity.
    return packageJson
      .split("\n")
      .filter((l) => !IDENTIFYING_PACKAGE_JSON_KEYS.some((k) => l.includes('"' + k + '"')))
      .join("\n");
  }
}

function repoUrlOf(packageJson: string | null): string | null {
  if (!packageJson) return null;
  try {
    const o = JSON.parse(packageJson) as any;
    const r = o.repository;
    return typeof r === "string" ? r : (r?.url ?? null);
  } catch {
    const m = packageJson.match(/"url"\s*:\s*"([^"]*github[^"]*)"/i);
    return m?.[1] ?? null;
  }
}

export function buildContent(text: PackageText, spec: ConditionSpec): BuiltContent {
  const hasReadme = Boolean(text.readme && text.readme.trim());
  const hasPj = Boolean(text.package_json && text.package_json.trim());
  const evidenceEmpty = !hasReadme && !hasPj;

  // The recall probe is asked about a name and given no text at all.
  if (!spec.withText) {
    return {
      content: "npm package: " + text.pkg_name,
      evidenceEmpty: false,
      residual: [],
      blindReplacements: 0,
    };
  }

  const parts: string[] = [];
  let residual: string[] = [];
  let replacements = 0;

  if (spec.blinded) {
    const pseudo = pseudonymFor(text.pkg_name);
    const repo = repoUrlOf(text.package_json);
    parts.push("Package name: " + pseudo.full);
    parts.push("(The name, scope, repository and contact details have been replaced.)");
    if (hasReadme) {
      const b = blind(text.readme as string, text.pkg_name, repo, pseudo);
      residual = b.residual;
      replacements += b.replacements;
      parts.push("", "README", "------", b.text);
    }
    if (hasPj) {
      const b = blind(stripIdentity(text.package_json as string), text.pkg_name, repo, pseudo);
      residual = [...new Set([...residual, ...b.residual])];
      replacements += b.replacements;
      parts.push("", "package.json (identifying fields removed)", "------", b.text);
    }
  } else {
    parts.push("Package name: " + text.pkg_name);
    if (hasReadme) parts.push("", "README", "------", text.readme as string);
    if (hasPj) parts.push("", "package.json", "------", text.package_json as string);
  }

  if (evidenceEmpty) {
    // Stated plainly rather than left as an empty section. The question is whether the
    // model declines when told there is nothing, not whether it notices the absence.
    parts.push("", "This package ships no README and no readable package.json.");
  }

  return {
    content: parts.join("\n"),
    evidenceEmpty,
    residual,
    blindReplacements: replacements,
  };
}
