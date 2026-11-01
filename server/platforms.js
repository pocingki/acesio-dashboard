import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Kolom Referensi memakai kosakata platform yang SAMA dengan bot WA (berkas keywords.json):
// `platforms`, `referralCodes`, dan `defaultPlatform`. Bagian lain berkas itu (triggers, hotStrong, dst.)
// milik bot dan tidak dibaca di sini. Dengan satu berkas bersama, nama platform di dashboard dan di bot
// selalu persis sama, jadi data dari kedua sisi tidak bentrok saat digabung.
//
// Lokasi berkas: env KEYWORDS_FILE, bila kosong <repo>/config/keywords.json (bukan relatif ke cwd).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keywordsPath = () => (process.env.KEYWORDS_FILE ? path.resolve(process.env.KEYWORDS_FILE) : path.join(ROOT, 'config', 'keywords.json'));

// Kunci pembanding: huruf kecil, selain huruf/angka jadi spasi tunggal ("Google (organik)" -> "google organik").
const keyOf = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Kata pengantar yang boleh mendahului nama platform: "dari IG", "via fb", "ref IG01".
const FILLER = new Set(['dari', 'via', 'lewat', 'melalui', 'dr', 'ref', 'referensi', 'sumber', 'kode']);
// Imbuhan yang diterima untuk kata tunggal >= 5 huruf ("instagramnya"). Sengaja daftar tertutup, bukan
// huruf apa saja, supaya "insta" tidak ikut mencocokkan "instan".
const SUFFIXES = ['nya', 'kan', 'lah', 'kah', 'pun', 'an', 'i'];
const MIN_AFFIX_LETTERS = 5;

let cache = { file: '', mtime: -1, table: new Map(), names: [], fallback: '', problems: [] };
let warned = '';

function build(json) {
  const table = new Map(); // kunci -> nama platform baku
  const problems = [];
  const put = (alias, platform, from) => {
    const k = keyOf(alias);
    if (!k) return;
    const have = table.get(k);
    if (have && have !== platform) problems.push(`“${alias}” (${from}) sudah dipakai ${have}; diabaikan untuk ${platform}`);
    else table.set(k, platform);
  };
  const platforms = json && typeof json.platforms === 'object' && json.platforms ? json.platforms : {};
  // Urutan prioritas sama dengan bot: kode referral dulu, lalu nama baku, lalu kata kunci di `platforms`.
  for (const [code, p] of Object.entries(json?.referralCodes || {})) if (typeof p === 'string') put(code, p, 'referralCodes');
  for (const p of Object.keys(platforms)) put(p, p, 'nama platform');
  for (const [p, list] of Object.entries(platforms)) for (const a of Array.isArray(list) ? list : []) put(a, p, 'platforms');
  const fallback = typeof json?.defaultPlatform === 'string' ? json.defaultPlatform.trim() : '';
  if (fallback) put(fallback, fallback, 'defaultPlatform');
  const names = [...Object.keys(platforms), ...(fallback && !(fallback in platforms) ? [fallback] : [])];
  return { table, names, fallback, problems };
}

function load() {
  const file = keywordsPath();
  let mtime = -1;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* dilaporkan di bawah */ }
  if (cache.file === file && cache.mtime === mtime) return cache;
  let parsed = { table: new Map(), names: [], fallback: '', problems: [] };
  if (mtime < 0) {
    if (warned !== `missing:${file}`) { console.warn(`[platform] ${file} tidak ditemukan; kolom Referensi disimpan apa adanya.`); warned = `missing:${file}`; }
  } else {
    try {
      parsed = build(JSON.parse(fs.readFileSync(file, 'utf8')));
      for (const p of parsed.problems) console.warn(`[platform] bentrok kata kunci: ${p}`);
    } catch (e) {
      if (warned !== `bad:${file}:${mtime}`) { console.warn(`[platform] ${file} tidak bisa dibaca (${e.message}); kolom Referensi disimpan apa adanya.`); warned = `bad:${file}:${mtime}`; }
    }
  }
  cache = { file, mtime, ...parsed };
  return cache;
}

const stripFiller = (tokens) => {
  let i = 0;
  while (i < tokens.length - 1 && FILLER.has(tokens[i])) i++;
  return tokens.slice(i);
};

// "fb" -> "Facebook", "IG01" -> "Instagram", "dari ig" -> "Instagram", "google ads" -> "Google Ads".
// Hanya bila SELURUH isian adalah satu platform. Teks bebas seperti "Teman" atau "Dr. Budi" tidak diubah,
// begitu juga kalimat yang hanya menyebut platform di tengah ("IG kak Rina"), supaya keterangannya tidak hilang.
// Hasil selalu sama bila dijalankan lagi (idempoten).
export function resolveReference(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const { table } = load();
  if (!table.size) return raw;
  const tokens = stripFiller(keyOf(raw).split(' ').filter(Boolean));
  const whole = tokens.join(' ');
  if (table.has(whole)) return table.get(whole);
  if (tokens.length === 1 && whole.length > MIN_AFFIX_LETTERS) {
    for (const s of SUFFIXES) {
      const base = whole.endsWith(s) ? whole.slice(0, -s.length) : '';
      if (base.length >= MIN_AFFIX_LETTERS && table.has(base)) return table.get(base);
    }
  }
  return raw;
}

export const platformNames = () => [...load().names];
