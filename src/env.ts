import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Never load these keys from a file — they must come from the process environment. */
export const ENV_FILE_FORBIDDEN = new Set(["XVCACHE_TSA_PASSWORD"]);

const KEY = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parse a dotenv-style file. Quoted values keep `#` and spaces; unquoted `#` starts a comment after whitespace. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(KEY);
    if (!m) continue;
    out[m[1]] = unquoteEnvValue(m[2]);
  }
  return out;
}

export function unquoteEnvValue(raw: string): string {
  const first = raw[0];
  if (first === '"' || first === "'") {
    let acc = "";
    let escaped = false;
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) {
        acc += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\" && first === '"') {
        escaped = true;
        continue;
      }
      if (ch === first) return acc;
      acc += ch;
    }
    return acc;
  }
  const comment = raw.search(/\s+#/);
  return (comment >= 0 ? raw.slice(0, comment) : raw).trim();
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function envFileCandidates(opts: { cwd?: string; dirs?: string[] } = {}): string[] {
  const dirs = opts.dirs ?? [repoRoot(), opts.cwd ?? process.cwd()];
  const names = [".env", ".env.local"];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.resolve(dir, name);
      if (!seen.has(p)) {
        seen.add(p);
        files.push(p);
      }
    }
  }
  return files;
}

export type LoadLocalEnvResult = { file: string; applied: string[]; skipped: string[] };

/**
 * Load non-secret values from `.env` then `.env.local` (repo root, then cwd).
 * Later files win among themselves. Existing `process.env` values are never overwritten.
 * `XVCACHE_TSA_PASSWORD` in a file is ignored.
 */
export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env, opts: { cwd?: string; dirs?: string[] } = {}): LoadLocalEnvResult[] {
  type Pending = { file: string; parsed: Record<string, string> };
  const pending: Pending[] = [];
  for (const file of envFileCandidates(opts)) {
    if (!existsSync(file)) continue;
    try {
      pending.push({ file, parsed: parseEnvFile(readFileSync(file, "utf8")) });
    } catch {
      continue;
    }
  }
  // Later files win among themselves (.env.local over .env, cwd over repo).
  const merged: Record<string, { value: string; file: string }> = {};
  for (const item of pending) {
    for (const [key, value] of Object.entries(item.parsed)) {
      merged[key] = { value, file: item.file };
    }
  }
  const byFile = new Map<string, { applied: string[]; skipped: string[] }>();
  for (const item of pending) byFile.set(item.file, { applied: [], skipped: [] });
  for (const [key, { value, file }] of Object.entries(merged)) {
    const slot = byFile.get(file)!;
    if (ENV_FILE_FORBIDDEN.has(key)) {
      slot.skipped.push(key);
      continue;
    }
    if (env[key] !== undefined && env[key] !== "") {
      slot.skipped.push(key);
      continue;
    }
    env[key] = value;
    slot.applied.push(key);
  }
  // Keys overridden by a later file are recorded as skipped on the earlier file.
  for (const item of pending) {
    const slot = byFile.get(item.file)!;
    for (const key of Object.keys(item.parsed)) {
      if (merged[key].file !== item.file && !slot.applied.includes(key) && !slot.skipped.includes(key)) {
        slot.skipped.push(key);
      }
    }
  }
  return pending.map((item) => ({ file: item.file, ...byFile.get(item.file)! }));
}
