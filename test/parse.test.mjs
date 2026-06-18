/**
 * Offline parser tests against the saved reference search page. These run
 * without network access by parsing the fixture HTML in test/fixtures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSearchResults } from "../lib/annas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = "https://annas-archive.gd";
const html = readFileSync(
  join(__dirname, "fixtures", "search_test-search.html"),
  "utf-8"
);

const results = parseSearchResults(html, BASE_URL);

test("extracts all results", () => {
  assert.equal(results.length, 50);
});

test("no missing core fields", () => {
  for (const r of results) {
    assert.ok(r.title, "title");
    assert.ok(r.author, "author");
    assert.ok(r.format, "format");
    assert.ok(r.url.startsWith(BASE_URL + "/md5/"), "url");
    assert.ok(r.cover_url && r.cover_url.startsWith("http"), "cover_url");
  }
});

test("format breakdown", () => {
  const counts = {};
  for (const r of results) counts[r.format] = (counts[r.format] || 0) + 1;
  assert.deepEqual(counts, { pdf: 29, epub: 18, mobi: 3 });
});

test("first result fields", () => {
  const first = results[0];
  assert.equal(first.title, "The man test : the Marin Test Series, #1");
  assert.equal(first.author, "Aksel, Amanda");
  assert.equal(first.format, "epub");
  assert.equal(first.md5, "6c6b69b79adac1241c1706cec47b4b89");
  assert.equal(
    first.cover_url,
    "https://covers.z-lib.sk/covers400/collections/foreignfiction/" +
      "21e02dcbb28c80cdcd74e9782199d00e411e6477277c0c195c473442cec676c3.jpg"
  );
  // Downloads are not in the static HTML, so the parser leaves them unset.
  assert.equal(first.downloads, null);
});
