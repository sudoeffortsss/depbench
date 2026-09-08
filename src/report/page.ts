/**
 * Generates the static results page.
 *
 *   npx tsx src/report/page.ts
 *
 * Static rather than a dashboard, on purpose. Research showed standalone dashboards go
 * unread, and a live service is a thing to operate. A file on GitHub Pages costs nothing
 * and cannot break.
 *
 * The page carries the limitations above the leaderboard rather than below it, because
 * the single most important thing a reader can know about these numbers is what they do
 * not mean.
 */

import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, openDb } from "../db/migrate.js";
import { SCORING_DATE } from "../snapshot/build.js";
import { computeMetrics, type Metrics, type ScoredPackage } from "../harness/metrics.js";
import { MODEL_ARMS, estimateCost } from "../policies/llm.js";
import { readUniverse } from "../ingest/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "docs");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b68;--line:#e2e2df;--accent:#8a5a2b;--warn:#a8442a}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--fg:#e8e8e5;--dim:#9a9a95;--line:#2e2e2b;--accent:#c99a63;--warn:#d4785a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:60rem;margin:0 auto;padding:3rem 1.25rem 6rem}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 .4rem;letter-spacing:-.02em}
h2{font-size:1.15rem;margin:2.75rem 0 .75rem;letter-spacing:-.01em}
.sub{color:var(--dim);margin:0 0 2rem}
.q{font-size:1.15rem;border-left:3px solid var(--accent);padding-left:1rem;margin:1.5rem 0 2rem}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}
th,td{text-align:right;padding:.5rem .55rem;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
th{font-weight:600;color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr.baseline td{background:color-mix(in srgb,var(--accent) 9%,transparent)}
tr.pending td{color:var(--dim);font-style:italic}
.wrap{overflow-x:auto;margin:0 -0.25rem}
.note{color:var(--dim);font-size:13.5px;margin-top:.6rem}
.limits{border:1px solid var(--line);border-left:3px solid var(--warn);padding:1rem 1.25rem;margin:1.5rem 0 2rem;border-radius:2px}
.limits h2{margin-top:0}
.limits p{margin:.5rem 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:color-mix(in srgb,var(--fg) 7%,transparent);padding:.1em .35em;border-radius:3px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1.2rem;font-size:13.5px;color:var(--dim)}
.kv b{font-weight:600;color:var(--fg);font-family:ui-monospace,Menlo,monospace}
footer{margin-top:4rem;padding-top:1.5rem;border-top:1px solid var(--line);color:var(--dim);font-size:13.5px}
a{color:var(--accent)}
td.chance{color:var(--muted);font-style:italic}
abbr{text-decoration:underline dotted;cursor:help}
`;

function row(m: Metrics): string {
  if (!m.ok) {
    return `<tr class="pending"><td>${esc(m.policy)}</td><td colspan="9">refused: ${esc(m.reason)}</td></tr>`;
  }
  const cls =
    m.policy === "popularity" || m.policy === "random" ? ' class="baseline"' : "";
  const p = (x: number) => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
  // An interval that contains 0.5 is the headline caveat, so it is marked in the row
  // itself rather than left to a footnote (FINDINGS.md F12).
  const ciCls = m.aucCi.includesChance ? ' class="chance"' : "";
  const ff = m.guardrails.falseFlagIsTautological
    ? '<abbr title="This policy ranks by staleness, so no actively maintained control can enter its riskiest decile. The rate is 0 by construction, not by precision.">n/a</abbr>'
    : p(m.guardrails.activeControlFalseFlagRate);
  return `<tr${cls}>
    <td>${esc(m.policy)}</td>
    <td><strong>${m.auc.toFixed(3)}</strong></td>
    <td${ciCls}>[${m.aucCi.lo.toFixed(3)}, ${m.aucCi.hi.toFixed(3)}]</td>
    <td>${m.casesScored}</td><td>${m.controlsScored}</td>
    <td>${p(m.coverage.scoredFraction)}</td>
    <td>${p(m.coverage.abstainRate)}</td>
    <td>${p(m.coverage.noAnswerRate)}</td>
    <td>${p(m.guardrails.topDecileCaseRecall)}</td>
    <td>${ff}</td>
  </tr>`;
}

async function main(): Promise<void> {
  const db = await openDb();
  try {
    await migrate(db);

    const run = await db.query<{ id: string; universe_hash: string }>(
      `SELECT id, universe_hash FROM run ORDER BY id DESC LIMIT 1`,
    );
    if (run.rows.length === 0) throw new Error("no run; score first");
    const runId = Number(run.rows[0]!.id);
    const universeHash = run.rows[0]!.universe_hash;

    const raw = await db.query<any>(
      `SELECT ps.policy, ps.pkg_name, ps.score, ps.abstain, ps.parse_status, ps.cost_usd,
              (o.pkg_name IS NOT NULL) AS is_case,
              s.releases_last_90d, s.downloads_prior_month
         FROM policy_score ps
         JOIN snapshot s ON s.pkg_name=ps.pkg_name AND s.as_of_date=ps.as_of_date
         LEFT JOIN outcome o ON o.pkg_name=ps.pkg_name AND o.as_of_date=ps.as_of_date
                            AND o.kind='advisory'
        WHERE ps.run_id=$1`,
      [runId],
    );

    const byPolicy = new Map<string, ScoredPackage[]>();
    for (const r of raw.rows) {
      const list = byPolicy.get(r.policy) ?? [];
      list.push({
        pkg_name: r.pkg_name,
        score: r.score === null ? null : Number(r.score),
        abstain: r.abstain,
        parse_status: r.parse_status,
        is_case: r.is_case,
        releases_last_90d: r.releases_last_90d,
        downloads_prior_month:
          r.downloads_prior_month === null ? null : Number(r.downloads_prior_month),
      });
      byPolicy.set(r.policy, list);
    }

    const results = [...byPolicy].map(([p, l]) => computeMetrics(p, l));
    results.sort((a, b) => ((b.ok ? b.auc : -1) - (a.ok ? a.auc : -1)));

    const sealed = (await readdir(join(ROOT, "predictions")).catch(() => [])).filter((f) =>
      f.endsWith(".jsonl"),
    );

    // Counts come from the frozen manifest, so the page cannot drift from the set that
    // was actually scored.
    const manifest = JSON.parse(
      await readFile(join(ROOT, "universe", "universe.json"), "utf8"),
    ) as { member_count: number; case_count: number; control_count: number };
    const caseN = manifest.case_count;
    const ctlN = manifest.control_count;
    const members = await readUniverse();
    if (members.length !== manifest.member_count) {
      throw new Error(
        `universe.json declares ${manifest.member_count} members, universe.tsv has ` +
          `${members.length}`,
      );
    }

    // Restricted to current members for the same reason src/policies/run.ts is:
    // `snapshot` is append-only and still holds rows for packages that left the
    // universe when it was refrozen, and averaging over them would describe a
    // population nothing was scored against.
    const memberNames = members.map((m: { name: string }) => m.name);
    const feat = await db.query<any>(
      `SELECT (o.pkg_name IS NOT NULL) AS is_case, count(*) n,
              round(avg(s.days_since_last_pub)) stale,
              round(avg(s.downloads_prior_month)) dl,
              round(100.0*avg(CASE WHEN s.has_repo_url THEN 1 ELSE 0 END)) repo
         FROM snapshot s
         LEFT JOIN outcome o ON o.pkg_name=s.pkg_name AND o.as_of_date=s.as_of_date
                            AND o.kind='advisory'
        WHERE s.as_of_date=$1 AND s.reconstructed AND s.pkg_name = ANY($2::text[])
        GROUP BY 1 ORDER BY 1`,
      [SCORING_DATE, memberNames],
    );
    const ctl = feat.rows.find((r: any) => !r.is_case);
    const cse = feat.rows.find((r: any) => r.is_case);

    const armRows = MODEL_ARMS.map((a) => {
      const e = estimateCost(a, members.length);
      // The cutoff is shown because it is what makes the arm interpretable at all, not
      // as a spec detail: without it the cases cannot be split and a good score cannot
      // be told apart from the model having read the advisory.
      return `<tr class="pending"><td>${esc(a.policy)}</td><td colspan="9">` +
        `<strong>${esc(a.model)}</strong> — not run, built and registered. ` +
        `Training cutoff ${esc(a.trainingCutoff)}, which splits the cases ` +
        `${a.caseSplit.preCutoff}/${a.caseSplit.postCutoff}. ` +
        `A batched run would cost about $${e.usdBatched.toFixed(2)}.</td></tr>`;
    }).join("\n");

    const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>truthlag — do npm dependency risk signals predict anything?</title>
<style>${CSS}</style>
<main>
<h1>truthlag</h1>
<p class="sub">Do npm dependency risk signals actually predict anything?</p>

<p class="q">Reconstruct what was knowable about a package on <strong>${SCORING_DATE}</strong>,
score it using only information available that day, then check what actually happened over
the next three and a half years. The question is not which model wins. It is whether any
of these signals is worth using at all.</p>

<div class="limits">
<h2>Read this before the table</h2>
<p><strong>Advisories measure scrutiny, not danger.</strong> A vulnerability has to be
<em>found</em> before it becomes an advisory, and nobody audits a package nobody uses.
37% of the cases here sit above a million monthly downloads, against 5.2% of the eligible
npm population they were drawn from. These numbers measure agreement with where attention
went, not with where danger was.</p>
<p><strong>Case-control changes what the numbers mean.</strong> The positive rate is set by
the design, not by nature, so <code>precision@k</code> is not interpretable and AUC is the
headline. Controls are matched to cases on download band <em>and</em> scope style, so the
two groups share those distributions by construction and neither can be read as a finding.</p>
<p><strong>Every interval here is wide.</strong> The whole leaderboard spans about 0.17 of
AUC and the intervals are roughly ±0.025, so small gaps between adjacent policies are not
differences. An interval printed in grey contains 0.500, meaning chance is not excluded.</p>
<p><strong>The universe is not npm.</strong> It is ${(caseN + ctlN).toLocaleString()}
packages with real usage and real advisories, not the 4.3 million package registry.</p>
</div>

<h2>Leaderboard</h2>
<div class="wrap">
<table>
<thead><tr>
<th>policy</th><th>AUC</th><th>95% CI</th><th>cases</th><th>controls</th>
<th>scored</th><th>abstain</th><th>no answer</th><th>top 10%</th><th>false flag</th>
</tr></thead>
<tbody>
${results.map(row).join("\n")}
${armRows}
</tbody>
</table>
</div>
<p class="note">AUC 0.5 is chance. Highlighted rows are the two baselines every other
policy has to beat. <strong>None does.</strong> The three policies built from actual
health signals all land below chance.</p>

<h2>Why the signals point the wrong way</h2>
<div class="wrap">
<table>
<thead><tr><th>group</th><th>n</th><th>days since last publish</th><th>monthly downloads</th><th>has public repo</th></tr></thead>
<tbody>
<tr><td>controls</td><td>${ctl?.n}</td><td>${ctl?.stale}</td><td>${Number(ctl?.dl).toLocaleString()}</td><td>${ctl?.repo}%</td></tr>
<tr><td>cases</td><td>${cse?.n}</td><td>${cse?.stale}</td><td>${Number(cse?.dl).toLocaleString()}</td><td>${cse?.repo}%</td></tr>
</tbody>
</table>
</div>
<p class="note">Packages that received an advisory were <strong>fresher</strong>, far more
downloaded, and more likely to be developed in public. "Stale means risky" — the intuition
this whole category rests on — points the wrong way against this ground truth, not because
staleness is safe but because staleness is invisible.</p>

<h2>The prospective arm</h2>
<p>Every backtest knows how the story ended. This one does not: each day the same policies
score today's registry and the predictions are committed to a public repository before any
outcome exists. The commit timestamp is the evidence.</p>
<div class="kv">
<span>days sealed</span><b>${sealed.length}</b>
<span>predictions per day</span><b>9,575</b>
<span>first sealed</span><b>${sealed[0]?.replace(".jsonl", "") ?? "—"}</b>
</div>
<p class="note">This will not produce a meaningful result for a long time. The base rate is
low and disclosure takes a median of 31.5 months. It is running anyway, and saying so is
the point.</p>

<h2>Reproducing this</h2>
<p>Everything above cost nothing to produce. No model was called.</p>
<div class="kv">
<span>universe hash</span><b>${esc(universeHash.slice(0, 24))}…</b>
<span>scoring date</span><b>${SCORING_DATE}</b>
<span>observation window</span><b>2023-01-01 → 2026-09-01</b>
<span>cases / controls</span><b>${caseN.toLocaleString()} / ${ctlN.toLocaleString()}</b>
</div>
<p class="note"><code>npm install &amp;&amp; npm run migrate &amp;&amp; npm test</code> —
the database is PGlite, so there is no server to install. The universe was frozen and
committed before any policy existed; its hash is above.</p>

<footer>
<p><a href="https://github.com/sudoeffortsss/truthlag">Source, method and findings</a> ·
<a href="https://github.com/sudoeffortsss/truthlag/blob/main/FINDINGS.md">FINDINGS.md</a>
records sixteen things this project assumed, tested, and had to change, including
four defects in its own code — one of which had silently removed 40% of the evaluation
set before anything was scored.</p>
<p>Allen Cai · code Apache-2.0, data CC BY-SA 4.0 · download ranking from
<a href="https://ecosyste.ms">ecosyste.ms</a> (© 2022 Andrew Nesbitt)</p>
</footer>
</main>`;

    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "index.html"), html);
    console.log(`wrote docs/index.html  (${(html.length / 1024).toFixed(1)} KB)`);
    console.log(`  policies shown : ${results.length} scored + ${MODEL_ARMS.length} registered-unrun`);
    console.log(`  days sealed    : ${sealed.length}`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
