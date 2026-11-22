import { createHash } from "node:crypto";
import { canonicalJson } from "./journal.js";

/**
 * Merkle tree used by XVcache batches (RFC 6962 style domain separation):
 *   leaf = SHA256(0x00 || UTF8(canonicalJson(leafData)))
 *   node = SHA256(0x01 || left || right)
 * An odd node at the end of a level is promoted unchanged (no duplication).
 */

export type NoteLeaf = { k: "note"; p: string; h: string };
export type JournalLeaf = { k: "journal"; seq: number; h: string };
export type LeafData = NoteLeaf | JournalLeaf;

export type MerkleStep = { position: "left" | "right"; hash: string };

const HEX64 = /^[0-9a-f]{64}$/;

function sha(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function leafHash(data: LeafData): string {
  return sha(Buffer.from([0x00]), Buffer.from(canonicalJson(data), "utf8")).toString("hex");
}

export function nodeHash(leftHex: string, rightHex: string): string {
  return sha(Buffer.from([0x01]), Buffer.from(leftHex, "hex"), Buffer.from(rightHex, "hex")).toString("hex");
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) throw new Error("Merkle : aucune feuille.");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** Audit path for leaf `index`: siblings from bottom to top, with the sibling's side. */
export function merklePath(leaves: string[], index: number): MerkleStep[] {
  if (index < 0 || index >= leaves.length) throw new Error("Merkle : index hors limites.");
  const steps: MerkleStep[] = [];
  let level = leaves.slice();
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
