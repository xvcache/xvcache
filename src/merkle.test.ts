import { test } from "node:test";
import assert from "node:assert/strict";
import { leafHash, merkleRoot, merklePath, verifyMerklePath, nodeHash, type LeafData } from "./merkle.js";
import { sha256Hex } from "./journal.js";

function leaves(n: number): string[] {
  return Array.from({ length: n }, (_, i) => leafHash({ k: "note", p: `N${i}.md`, h: sha256Hex(`note ${i}`) }));
}

test("merkle: every leaf proves to the root, for 1..17 leaves", () => {
  for (let n = 1; n <= 17; n++) {
    const ls = leaves(n);
    const root = merkleRoot(ls);
    for (let i = 0; i < n; i++) {
      assert.ok(verifyMerklePath(ls[i], merklePath(ls, i), root), `n=${n} i=${i}`);
    }
  }
});

test("merkle: single leaf is its own root, two leaves hash with 0x01 prefix", () => {
  const ls = leaves(2);
  assert.equal(merkleRoot([ls[0]]), ls[0]);
  assert.equal(merkleRoot(ls), nodeHash(ls[0], ls[1]));
});

test("merkle: tampered leaf, sibling, or side -> proof fails (X)", () => {
  const ls = leaves(5);
  const root = merkleRoot(ls);
  const p = merklePath(ls, 2);
  const tamperedLeaf = leafHash({ k: "note", p: "N2.md", h: sha256Hex("note 2 modifiée") });
  assert.equal(verifyMerklePath(tamperedLeaf, p, root), false);
  const badSibling = p.map((s, i) => (i === 0 ? { ...s, hash: "0".repeat(64) } : s));
  assert.equal(verifyMerklePath(ls[2], badSibling, root), false);
  const swapped = p.map((s, i) => (i === 0 ? { ...s, position: s.position === "left" ? "right" as const : "left" as const } : s));
  assert.equal(verifyMerklePath(ls[2], swapped, root), false);
  assert.equal(verifyMerklePath(ls[2], [{ position: "left", hash: "zz" }], root), false);
});

test("merkle: leaf binds path and kind (no second-preimage across kinds)", () => {
  const h = sha256Hex("x");
  const a: LeafData = { k: "note", p: "A.md", h };
  const b: LeafData = { k: "note", p: "B.md", h };
  const j: LeafData = { k: "journal", seq: 1, h };
  assert.notEqual(leafHash(a), leafHash(b));
  assert.notEqual(leafHash(a), leafHash(j));
  const ls = leaves(4);
  // an inner node must not be accepted as a leaf of a shorter proof
  const inner = nodeHash(ls[0], ls[1]);
  assert.notEqual(leafHash({ k: "note", p: "N0.md", h: inner }), inner);
});
