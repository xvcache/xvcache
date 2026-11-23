import { test } from "node:test";
import assert from "node:assert/strict";
import * as merkle from "./merkle.js";
import { leafHash, merkleRoot, merklePath, verifyMerklePath, nodeHash, type MerkleStep } from "./merkle.js";
import { sha256Hex } from "./journal.js";

function leaves(n: number): string[] {
  return Array.from({ length: n }, (_, i) => leafHash({ k: "note", p: `N${i}.md`, h: sha256Hex(`note ${i}`) }));
}

/** Copy of merklePath as it was on 202711a: rebuilds every level for one index. */
function merklePathLegacy(leafList: string[], index: number): MerkleStep[] {
  if (index < 0 || index >= leafList.length) throw new Error("Merkle : index hors limites.");
  const steps: MerkleStep[] = [];
  let level = leafList.slice();
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sib = isRight ? i - 1 : i + 1;
    if (sib < level.length) steps.push({ position: isRight ? "left" : "right", hash: level[sib] });
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) {
      next.push(j + 1 < level.length ? nodeHash(level[j], level[j + 1]) : level[j]);
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return steps;
}

function merkleRootLegacy(leafList: string[]): string {
  if (leafList.length === 0) throw new Error("Merkle : aucune feuille.");
  let level = leafList.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** Same pattern as certify/witness batches: one root and a path per leaf. */
function allPathsProduction(ls: string[]): { root: string; paths: MerkleStep[][] } {
  const api = merkle as unknown as { merklePaths?: (leaves: string[]) => { root: string; paths: MerkleStep[][] } };
  if (typeof api.merklePaths === "function") return api.merklePaths(ls);
  const root = merkleRoot(ls);
  return { root, paths: ls.map((_, i) => merklePath(ls, i)) };
}

function resetCount(): void {
  const api = merkle as unknown as { resetMerkleNodeHashCount?: () => void };
  api.resetMerkleNodeHashCount?.();
}

function readCount(): number | undefined {
  const api = merkle as unknown as { merkleNodeHashCount?: number };
  return typeof api.merkleNodeHashCount === "number" ? api.merkleNodeHashCount : undefined;
}

test("merkle: new paths match the pre-fix implementation on 1, 2, 3, 7, 8, 9, 1000 and edges", () => {
  for (const n of [1, 2, 3, 7, 8, 9, 1000]) {
    const ls = leaves(n);
    const rootLegacy = merkleRootLegacy(ls);
    const produced = allPathsProduction(ls);
    assert.equal(merkleRoot(ls), rootLegacy, `root n=${n}`);
    assert.equal(produced.root, rootLegacy, `merklePaths root n=${n}`);
    assert.equal(produced.paths.length, n);
    for (let i = 0; i < n; i++) {
      const legacy = merklePathLegacy(ls, i);
      assert.deepEqual(produced.paths[i], legacy, `path n=${n} i=${i}`);
      assert.deepEqual(merklePath(ls, i), legacy, `merklePath n=${n} i=${i}`);
      assert.ok(verifyMerklePath(ls[i], produced.paths[i], produced.root), `verify n=${n} i=${i}`);
    }
    assert.throws(() => merklePath(ls, -1));
    assert.throws(() => merklePath(ls, n));
    assert.throws(() => merkleRoot([]));
  }
});

test("merkle: building every path stays under a linear hash bound (4000 leaves in a few seconds)", () => {
  const api = merkle as unknown as { merklePaths?: unknown };
  assert.equal(typeof api.merklePaths, "function", "merklePaths must exist so a batch does not rebuild the tree per leaf");
  const n = 4000;
  const ls = leaves(n);
  resetCount();
  const t0 = process.hrtime.bigint();
  const produced = allPathsProduction(ls);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(produced.paths.length, n);
  assert.ok(verifyMerklePath(ls[0], produced.paths[0], produced.root));
  assert.ok(verifyMerklePath(ls[n - 1], produced.paths[n - 1], produced.root));
  const mid = Math.floor(n / 2);
  assert.ok(verifyMerklePath(ls[mid], produced.paths[mid], produced.root));
  const count = readCount();
  // One tree uses < n node hashes. A per-leaf rebuild does Θ(n²) hashes
  // (≈ 8 million for n=4000). 4n is a linear bound that fails on the old loop.
  assert.ok(count !== undefined, "merkleNodeHashCount hook should be present");
  assert.ok(count! <= 4 * n, `nodeHash count ${count} should be ≤ 4n=${4 * n}`);
  assert.ok(ms < 8000, `4000 leaves took ${ms.toFixed(1)} ms, expected < 8000`);
});
