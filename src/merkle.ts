import { createHash } from "node:crypto";
import { canonicalJson } from "./journal.js";

/**
 * Merkle tree used by XVcache batches (RFC 6962 style domain separation):
 *   leaf = SHA256(0x00 || UTF8(canonicalJson(leafData)))
 *   node = SHA256(0x01 || left || right)
 * An odd node at the end of a level is promoted unchanged (no duplication).
 *
 * A tree is built once (O(n) node hashes). Audit paths are then read from the
 * stored levels in O(log n) per leaf, so a full batch is O(n log n) memory
 * walks and O(n) hashes — not one full rebuild per leaf.
 */

export type NoteLeaf = { k: "note"; p: string; h: string };
export type JournalLeaf = { k: "journal"; seq: number; h: string };
/** Hosted witness (hash-only mode): the leaf binds the proof id and the document fingerprint, never a tenant or a label. */
export type HashLeaf = { k: "hash"; id: string; h: string };
export type LeafData = NoteLeaf | JournalLeaf | HashLeaf;

export type MerkleStep = { position: "left" | "right"; hash: string };

const HEX64 = /^[0-9a-f]{64}$/;

/** Test hook: number of nodeHash calls since the last reset. */
export let merkleNodeHashCount = 0;
export function resetMerkleNodeHashCount(): void {
  merkleNodeHashCount = 0;
}

function sha(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function leafHash(data: LeafData): string {
  return sha(Buffer.from([0x00]), Buffer.from(canonicalJson(data), "utf8")).toString("hex");
}

export function nodeHash(leftHex: string, rightHex: string): string {
  merkleNodeHashCount++;
  return sha(Buffer.from([0x01]), Buffer.from(leftHex, "hex"), Buffer.from(rightHex, "hex")).toString("hex");
}

export type MerkleLevels = string[][];

/** Levels[0] is the leaf hashes; the last level is a single root. */
export function buildMerkleLevels(leaves: string[]): MerkleLevels {
  if (leaves.length === 0) throw new Error("Merkle : aucune feuille.");
  const levels: MerkleLevels = [leaves.slice()];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    }
    levels.push(next);
  }
  return levels;
}

const levelCache = new WeakMap<string[], MerkleLevels>();

function levelsFor(leaves: string[]): MerkleLevels {
  let levels = levelCache.get(leaves);
  if (!levels) {
    levels = buildMerkleLevels(leaves);
    levelCache.set(leaves, levels);
  }
  return levels;
}

export function merkleRoot(leaves: string[]): string {
  const levels = levelsFor(leaves);
  return levels[levels.length - 1][0];
}

export function merklePathFromLevels(levels: MerkleLevels, index: number): MerkleStep[] {
  const n = levels[0]?.length ?? 0;
  if (index < 0 || index >= n) throw new Error("Merkle : index hors limites.");
  const steps: MerkleStep[] = [];
  let i = index;
  for (let L = 0; L < levels.length - 1; L++) {
    const level = levels[L];
    const isRight = i % 2 === 1;
    const sib = isRight ? i - 1 : i + 1;
    if (sib < level.length) steps.push({ position: isRight ? "left" : "right", hash: level[sib] });
    i = Math.floor(i / 2);
  }
  return steps;
}

/** Audit path for leaf `index`: siblings from bottom to top, with the sibling's side. */
export function merklePath(leaves: string[], index: number): MerkleStep[] {
  return merklePathFromLevels(levelsFor(leaves), index);
}

/** Build the tree once and return the root plus every audit path. O(n) hashes. */
export function merklePaths(leaves: string[]): { root: string; paths: MerkleStep[][] } {
  const levels = levelsFor(leaves);
  return {
    root: levels[levels.length - 1][0],
    paths: leaves.map((_, i) => merklePathFromLevels(levels, i)),
  };
}

export function foldMerklePath(leafHex: string, steps: MerkleStep[]): string {
  let acc = leafHex;
  for (const s of steps) {
    if (!HEX64.test(s.hash)) throw new Error("Merkle : hash de chemin invalide.");
    acc = s.position === "left" ? nodeHash(s.hash, acc) : nodeHash(acc, s.hash);
  }
  return acc;
}

export function verifyMerklePath(leafHex: string, steps: MerkleStep[], rootHex: string): boolean {
  try { return foldMerklePath(leafHex, steps) === rootHex; } catch { return false; }
}
