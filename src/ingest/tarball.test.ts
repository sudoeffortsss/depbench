import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  extractText, readTar, safeTruncate, tarballUrl, README_CHAR_CAP,
} from "./tarball.js";

/** Builds a ustar entry: 512-byte header, then data padded to 512. */
function entry(path: string, body: string, typeflag = "0"): Uint8Array {
  const data = Buffer.from(body, "utf8");
  const header = Buffer.alloc(512);
  header.write(path.slice(0, 100), 0, "utf8");
  header.write("000644 \0", 100, "utf8");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write(typeflag, 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  // Checksum: sum of all header bytes with the checksum field read as spaces.
  header.write("        ", 148, "utf8");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");

  const pad = (512 - (data.length % 512)) % 512;
  return new Uint8Array(Buffer.concat([header, data, Buffer.alloc(pad)]));
}

function tar(...entries: Uint8Array[]): Uint8Array {
  return new Uint8Array(
    Buffer.concat([...entries.map((e) => Buffer.from(e)), Buffer.alloc(1024)]),
  );
}

describe("tarballUrl", () => {
  it("builds a plain package URL", () => {
    expect(tarballUrl("lodash", "4.17.21")).toBe(
      "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
    );
  });

  it("strips the scope from the filename but keeps it in the path", () => {
    // The scope appears once, not twice: /@babel/traverse/-/traverse-7.20.0.tgz
    expect(tarballUrl("@babel/traverse", "7.20.0")).toBe(
      "https://registry.npmjs.org/@babel/traverse/-/traverse-7.20.0.tgz",
    );
  });
});

describe("readTar", () => {
  it("reads names and contents", () => {
    const files = readTar(tar(entry("package/a.txt", "hello"), entry("package/b.txt", "world")));
    expect(files.map((f) => f.path)).toEqual(["package/a.txt", "package/b.txt"]);
    expect(new TextDecoder().decode(files[0]!.data)).toBe("hello");
  });

  it("handles a body whose length is not a multiple of 512", () => {
    const body = "x".repeat(700);
    const files = readTar(tar(entry("package/big.txt", body), entry("package/after.txt", "ok")));
    expect(new TextDecoder().decode(files[0]!.data)).toBe(body);
    // The entry after an unaligned one must still be found: this is the padding maths.
    expect(new TextDecoder().decode(files[1]!.data)).toBe("ok");
  });

  it("skips directory entries rather than emitting empty files", () => {
    const files = readTar(tar(entry("package/", "", "5"), entry("package/a.txt", "hi")));
    expect(files.map((f) => f.path)).toEqual(["package/a.txt"]);
  });

  it("stops at the end-of-archive marker instead of reading padding as entries", () => {
    expect(readTar(tar(entry("package/a.txt", "hi")))).toHaveLength(1);
  });

  it("returns nothing for an empty buffer rather than throwing", () => {
    expect(readTar(new Uint8Array(0))).toEqual([]);
  });
});

describe("extractText", () => {
  const wrap = (...e: Uint8Array[]) => new Uint8Array(gzipSync(Buffer.from(tar(...e))));

  it("finds README.md and package.json", () => {
    const t = extractText(
      wrap(entry("package/README.md", "# hi"), entry("package/package.json", '{"name":"x"}')),
      "x", "1.0.0",
    );
    expect(t.readme).toBe("# hi");
    expect(t.readme_path).toBe("package/README.md");
    expect(t.package_json).toBe('{"name":"x"}');
  });

  it("finds a lowercase README with an unusual extension", () => {
    // minimist ships readme.markdown; a case-sensitive match on README.md finds nothing.
    const t = extractText(wrap(entry("package/readme.markdown", "# m")), "m", "1.0.0");
    expect(t.readme).toBe("# m");
  });

  it("ignores a README nested inside the package", () => {
    // A fixture's README is not the package's own and would be misleading input.
    const t = extractText(wrap(entry("package/test/fixtures/README.md", "not this")), "x", "1.0.0");
    expect(t.readme).toBeNull();
  });

  it("does not mistake a translation for the README, even a longer one", () => {
    // Written expecting "prefer the largest" to win here, which was wrong: feeding a
    // model the Chinese README when an English one exists is worse input, not more of
    // it. A two-part extension is the signal, and the matcher requires a single one.
    const t = extractText(
      wrap(entry("package/README.md", "short"), entry("package/README.zh.md", "much longer text")),
      "x", "1.0.0",
    );
    expect(t.readme).toBe("short");
  });

  it("prefers the larger of two genuine root READMEs", () => {
    // `README` and `README.md` side by side: both are the package's own, so size is the
    // only signal for which is the real one.
    const t = extractText(
      wrap(entry("package/README", "stub"), entry("package/README.md", "the real document")),
      "x", "1.0.0",
    );
    expect(t.readme).toBe("the real document");
  });

  it("caps the README, because one 162 KB file doubled the measured mean", () => {
    const t = extractText(wrap(entry("package/README.md", "y".repeat(50_000))), "x", "1.0.0");
    expect(t.readme).toHaveLength(README_CHAR_CAP);
  });

  it("reports a missing README as null rather than an empty string", () => {
    const t = extractText(wrap(entry("package/index.js", "module.exports=1")), "x", "1.0.0");
    expect(t.readme).toBeNull();
    expect(t.package_json).toBeNull();
  });
});

describe("safeTruncate", () => {
  it("does not split an emoji across the cap", () => {
    // The ingest died 1,595 packages in on exactly this: a lone high surrogate is not
    // valid JSON and Postgres refuses the row.
    const out = safeTruncate("abc\u{1F680}def", 4);
    expect(out).toBe("abc");
    expect(/[\ud800-\udfff]/.test(out)).toBe(false);
  });

  it("keeps an emoji that fits whole", () => {
    expect(safeTruncate("ab\u{1F680}", 4)).toBe("ab\u{1F680}");
  });

  it("strips NUL, which Postgres text cannot hold at all", () => {
    expect(safeTruncate("a\u0000b", 10)).toBe("ab");
  });

  it("leaves ordinary text untouched", () => {
    expect(safeTruncate("# marked\n\nA parser.", 100)).toBe("# marked\n\nA parser.");
  });

  it("produces text that survives a JSON round trip", () => {
    const nasty = "x".repeat(7999) + "\u{1F600}\u0000";
    const out = safeTruncate(nasty, README_CHAR_CAP);
    expect(() => JSON.parse(JSON.stringify({ readme: out }))).not.toThrow();
    expect(/[\ud800-\udfff]/.test(out)).toBe(false);
  });
});
