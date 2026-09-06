import { openDb } from "../src/db/migrate.js";
const db = await openDb();

const r = await db.query<{ pkg_name: string; latest_version: string; latest_published_at: string }>(
  `SELECT pkg_name, latest_version, latest_published_at
   FROM snapshot WHERE as_of_date='2023-01-01' AND has_provenance = true`);
console.log("flagged as having provenance on the scoring date:");
for (const x of r.rows) console.log(`  ${x.pkg_name}  v${x.latest_version}  published ${x.latest_published_at}`);

for (const x of r.rows) {
  const o = await db.query<{ payload: any }>(
    `SELECT payload FROM observation WHERE source='npm_packument' AND external_id=$1
     ORDER BY fetched_at DESC LIMIT 1`, [x.pkg_name]);
  const pk = o.rows[0]!.payload;
  const v = pk.versions[x.latest_version];
  console.log(`\n  ${x.pkg_name} @ ${x.latest_version}`);
  console.log(`    reduced record: ${JSON.stringify(v)}`);
  console.log(`    time entry    : ${pk.time[x.latest_version]}`);
  // how many versions of this package carry attestations at all
  const withAtt = Object.entries<any>(pk.versions).filter(([,m]) => m.att);
  console.log(`    versions with attestations: ${withAtt.length} / ${Object.keys(pk.versions).length}`);
  const dated = withAtt.map(([ver]) => `${ver} @ ${pk.time[ver]?.slice(0,10)}`).slice(0, 8);
  console.log(`    earliest few: ${dated.join(", ")}`);
}
await db.close();
