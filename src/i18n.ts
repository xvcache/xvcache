import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The 24 official EU languages (https://european-union.europa.eu/principles-countries-history/languages_en). */
export const EU_LANGS = [
  "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr",
  "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv",
] as const;
export type Lang = (typeof EU_LANGS)[number];

/** V1: these verdict strings exist only in fr.json and en.json; other locales fall back to English. */
export const FR_EN_ONLY_CERT_KEYS = [
  "title_signature_unverified", "subtitle_signature_unverified", "verdict_signature_unverified",
  "title_signature_invalid", "subtitle_signature_invalid", "verdict_signature_invalid",
  "title_ots_only", "subtitle_ots_only", "verdict_ots_only",
  "title_ots_pending", "subtitle_ots_pending", "verdict_ots_pending",
  "reverify_3_incomplete",
  "warn_signature_invalid", "signature_invalid_line",
  "warn_ots_only", "warn_ots_pending",
  "warn_signature_unverified", "signature_unverified_line",
] as const;

export const DEFAULT_LANG: Lang = "en";
export const DEFAULT_TZ = "Europe/Brussels";

type Dict = { [k: string]: string | string[] | Dict | boolean };

export type Locale = {
  lang: Lang;
  name: string;
  /** true only once a legal professional who speaks the language has reviewed it. */
  reviewed: boolean;
  cert: Record<string, string>;
  offer: Record<string, string | string[]>;
};

export function localesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "locales");
}

const cache = new Map<string, Locale>();

function readLocale(code: string): Locale | null {
  const file = path.join(localesDir(), `${code}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Locale;
}

/** Normalise "de-AT", "DE", "pt_BR" to an EU code; unknown → null. */
export function normalizeLang(input?: string | null): Lang | null {
  if (!input) return null;
  const base = input.trim().toLowerCase().replace("_", "-").split("-")[0];
  return (EU_LANGS as readonly string[]).includes(base) ? (base as Lang) : null;
}

/** Resolve a requested language: unsupported or missing → English, never an error. */
export function resolveLang(input?: string | null): { lang: Lang; requested: string | null; fallback: boolean } {
  const n = normalizeLang(input);
  return { lang: n ?? DEFAULT_LANG, requested: input ?? null, fallback: !!input && !n };
}

/** Locale with per-key fallback to English (a missing key never breaks a PDF). */
export function loadLocale(input?: string | null): Locale {
  const { lang } = resolveLang(input);
  const hit = cache.get(lang);
  if (hit) return hit;
  const en = readLocale("en");
  if (!en) throw new Error("locales/en.json manquant");
  const own = lang === "en" ? en : readLocale(lang);
  const merged: Locale = own
    ? { ...en, ...own, lang, cert: { ...en.cert, ...own.cert }, offer: { ...en.offer, ...own.offer } }
    : en;
  cache.set(lang, merged);
  return merged;
}

export function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export type LocalTime = { iso: string; utc: string; local: string; tz: string };

/** Date in the reader's language, always with UTC next to the local time (24 h clock). */
export function formatLocalDateTime(iso: string, lang: Lang, tz: string = DEFAULT_TZ): LocalTime {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Unreadable date: ${iso}`);
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "medium", hourCycle: "h23", timeZone }).format(d);
  let zone = tz;
  let local: string;
  try { local = fmt(zone); } catch { zone = DEFAULT_TZ; local = fmt(zone); }
  return { iso, utc: fmt("UTC"), local, tz: zone };
}
