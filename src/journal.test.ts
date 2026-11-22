import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JournalWriter,
  sha256Hex,
  verifyJournalFile,
  formatNoteVerdict,
  lastNoteRecord,
  parseEntry,
  readCompleteJournalLines,
  type JournalEntry,
} from "./journal.js";

test("verify_journal: V when the note matches the last fingerprint, X after an out-of-band edit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-verdict-"));
  const journalPath = path.join(dir, "xvcache-journal.jsonl");
  const noteRel = "Tests/Memo.md";
  const notePath = path.join(dir, "vault", noteRel);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  try {
    const writer = new JournalWriter(journalPath);
    const original = "# Memo\nContenu d'origine.\n";
    await fs.writeFile(notePath, original, "utf8");
    const sha = sha256Hex(await fs.readFile(notePath));
    const entry = await writer.append({
      tool: "write_note",
      args: { path: noteRel, mode: "create" },
      client: "xvcache-test",
      result: "ok",
      note_sha256: sha,
    });

    const chain = await verifyJournalFile(journalPath);
    assert.equal(chain.ok, true);
    assert.equal(chain.entries, 1);

    const lines = await readCompleteJournalLines(journalPath);
    const entries: JournalEntry[] = lines.map((line) => {
      const parsed = parseEntry(line);
      if ("error" in parsed) throw new Error(parsed.error);
      return parsed;
    });
    const rec = lastNoteRecord(entries, noteRel);
    assert.ok(rec);

    const v = formatNoteVerdict(noteRel, rec, sha);
    assert.equal(v.glyph, "V");
    assert.match(v.message, /^V  intacte/);
    assert.match(v.message, /intacte depuis/);
    assert.match(v.message, /xvcache-test/);

    await fs.writeFile(notePath, original + "ajout hors XVcache\n", "utf8");
    const shaX = sha256Hex(await fs.readFile(notePath));
    assert.notEqual(sha, shaX);

    const x = formatNoteVerdict(noteRel, rec, shaX);
    assert.equal(x.glyph, "X");
    assert.match(x.message, /^X  MODIFIÉE hors XVcache/);
    assert.match(x.message, /MODIFIÉE hors XVcache après/);

    // Editing the note does not break the journal chain.
    const chainAfter = await verifyJournalFile(journalPath);
    assert.equal(chainAfter.ok, true);
    assert.equal(chainAfter.lastHash, entry.hash);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
