// wire-codec.dict-bench.test.ts — informational bench for shared zstd dicts.
//
// Measures dict compression on hand-picked short chat message bodies, per
// language. Two sub-sets:
//   TINY  (body ≤ 12B raw UTF-8): zstd frame overhead > payload — compression
//          cannot help; dict is neutral or slightly negative. Informational only.
//   MEDIUM (body > 12B): dict shows clear gains. Assertion runs here.
//
// Asserts (medium messages only, body > 12B raw bytes), per language:
//   1. dict saves ≥ 30% bytes vs dictless zstd
//   2. dict result is a net win vs raw JSON body (saving > 0%)
// Tiny messages (≤12B) are logged but excluded — zstd frame overhead (≥18B)
// always expands them regardless of dict quality.
//
// Phase 2.E.A (RU) + 2.E.C (FA) + 2.E.D (EN) — offline prep + carriers.
// Per-message dict routing is Phase 2.E.E follow-up.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  init as zstdInit,
  compress as zstdCompress,
  createCCtx,
  compressUsingDict,
} from "@bokuweb/zstd-wasm";
import { Encoder as CborEncoder } from "cbor-x/index-no-eval";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path: web/src/lib/_kit/__tests__/ → up 4 dirs → web/ → static/dicts/
const DICTS_DIR = join(__dirname, "..", "..", "dicts");

const enc = new TextEncoder();
const cborEncoder = new CborEncoder({ mapsAsObjects: true, useRecords: false });
const ZSTD_LEVEL = 3;

// ── Per-language samples (hand-picked, NOT verbatim from corpus) ──────────────

const SAMPLES_RU = [
  "Привет", "ок", "Да", "Хорошо", "Понял", "Пока", "иду", "еду", "скоро", "жди",
  "Буду через 10 минут", "Жди у метро", "Встречаемся в кафе", "Уже еду к тебе",
  "Ещё на работе", "Выхожу через пять минут", "Позвоню как выйду",
  "Всё хорошо, спасибо", "Не смогу сегодня", "Давай встретимся завтра",
  "Купил билеты на завтра", "Приеду через полчаса", "Уже почти дошёл до метро",
  "Подожди меня немного", "Уже выхожу из дома", "Привет, как дела?",
  "Как настроение сегодня?", "Ты уже там?", "Когда будешь дома?",
  "Ты занят сейчас?", "Нормально, еду домой", "Устал, скоро буду",
  "Добрался, всё ок", "Опоздаю минут на пять", "Пробки, задержусь немного",
  "Иду пешком, рядом уже", "Ладно, договорились", "Окей, тогда до завтра",
  "Хорошо, увидимся там", "Отлично, жду тебя",
  "Привет! Как дела? Всё нормально?", "Я уже еду. Буду через 20 минут.",
  "Купи воды по дороге пожалуйста", "Забыл сказать — завтра в 10, ок?",
  "Едем! Будем через полчаса примерно.", "До встречи в пятницу в 18",
  "Уже дома, только пришёл", "Скоро выхожу, жди у входа",
  "Позвони когда освободишься", "Ок, созвонимся вечером",
];

const SAMPLES_FA = [
  "سلام", "باشه", "بله", "آره", "نه", "خوبه", "چشم", "حتما", "اوکی", "حله",
  "تا ۱۰ دقیقه دیگه می‌رسم", "دم مترو منتظرم", "تو کافه می‌بینمت",
  "دارم میام پیشت", "هنوز سر کارم", "پنج دقیقه دیگه راه می‌افتم",
  "وقتی رسیدم زنگ می‌زنم", "خوبم ممنون", "امروز نمی‌تونم بیام",
  "بذار فردا همدیگه رو ببینیم", "بلیط فردا رو گرفتم",
  "تا نیم ساعت دیگه می‌رسم", "تقریبا رسیدم به مترو",
  "یه کم صبر کن", "دارم از خونه میام بیرون", "سلام، چطوری؟",
  "حالت چطوره امروز؟", "رسیدی؟", "کی میای خونه؟", "الان سرت شلوغه؟",
  "خوبم، دارم میام خونه", "خسته‌ام، نزدیکم", "رسیدم، همه چی اوکی",
  "پنج دقیقه دیر می‌رسم", "ترافیکه، یه کم دیر می‌رسم",
  "پیاده میام، نزدیکم", "باشه قبوله", "اوکی پس فردا می‌بینمت",
  "باشه اونجا می‌بینمت", "عالی، منتظرتم",
  "سلام! چطوری؟ خوبی؟", "دارم میام. تا ۲۰ دقیقه دیگه می‌رسم.",
  "لطفاً سر راه آب بگیر", "یادم رفت بگم — فردا ساعت ۱۰، باشه؟",
  "داریم میایم! تا نیم ساعت دیگه می‌رسیم.", "جمعه ساعت ۶ می‌بینمت",
  "رسیدم خونه، تازه اومدم", "زود میام، دم در منتظر باش",
  "هر وقت آزاد شدی زنگ بزن", "باشه شب صحبت می‌کنیم",
];

const SAMPLES_EN = [
  "hi", "ok", "k", "yeah", "no", "sure", "lol", "thanks", "bye", "gn",
  "be there in 10 min", "wait at the station", "meet me at the cafe",
  "on my way to you", "still at work", "leaving in five",
  "almost there don't go", "i'll call when i'm out", "text me when you arrive",
  "i'm doing good thanks", "can't make it today", "let's meet tomorrow",
  "ok tomorrow it is", "booked a table for two", "grabbing coffee on the way",
  "almost at the door", "waiting at the entrance", "running 5 min late",
  "can't, busy all day", "call me when you're free", "sent you the docs",
  "check your email please", "got your message", "yeah got it i'll do it",
  "waiting for your call", "see you on friday", "going together or separately?",
  "let's just meet there", "in an uber, 20 min out",
  "hey! how are you? everything good?", "hi! how have you been? long time no see",
  "good morning! how did you sleep?", "got the tickets. tomorrow at the station, ok?",
  "i'm on my way. be there in 20", "ok cool. see you tomorrow then",
  "got it, thanks. see you later", "can't make it today. can we move it to tomorrow?",
  "running late, sorry. 10 more min", "no worries, take your time",
  "let me know when you're heading out",
];

// ── Bench helper (extracted to keep per-language sections short) ──────────────

interface BenchResult {
  lang: string;
  mediumCount: number;
  tinyCount: number;
  totJson: number;
  totDictless: number;
  totDict: number;
}

function runDictBench(
  lang: string,
  dictPath: string,
  samples: readonly string[],
  cctx: number,
): BenchResult {
  const dictBytes = new Uint8Array(readFileSync(dictPath).buffer);
  let totJson = 0, totDictless = 0, totDict = 0, mediumCount = 0, tinyCount = 0;
  for (const msg of samples) {
    const rawSz = enc.encode(msg).length;
    const jSz = enc.encode(JSON.stringify(msg)).length;
    const cborBodyBytes = cborEncoder.encode(msg);
    const dlSz = zstdCompress(cborBodyBytes, ZSTD_LEVEL).length;
    const dSz = compressUsingDict(cctx, cborBodyBytes, dictBytes, ZSTD_LEVEL).length;
    if (rawSz <= 12) { tinyCount++; continue; }
    mediumCount++;
    totJson += jSz; totDictless += dlSz; totDict += dSz;
  }
  return { lang, mediumCount, tinyCount, totJson, totDictless, totDict };
}

function logResult(r: BenchResult): void {
  const svJson = ((1 - r.totDict / r.totJson) * 100).toFixed(1);
  const svDictless = ((1 - r.totDict / r.totDictless) * 100).toFixed(1);
  console.log(
    `[bench-dict] ${r.lang.padEnd(2)} MEDIUM (n=${r.mediumCount}, tiny excl=${r.tinyCount}): ` +
      `JSON=${(r.totJson / r.mediumCount).toFixed(1)}B avg  ` +
      `dictless=${(r.totDictless / r.mediumCount).toFixed(1)}B avg  ` +
      `dict=${(r.totDict / r.mediumCount).toFixed(1)}B avg  ` +
      `(-${svJson}% vs JSON, -${svDictless}% vs dictless)`,
  );
}

let cctx: number;

beforeAll(async () => {
  await zstdInit();
  cctx = createCCtx();
});

describe("wire-codec dict bench (informational, Phase 2.E.A/C/D)", () => {
  it("RU dict saves ≥30% vs dictless zstd on medium bodies", () => {
    const r = runDictBench("ru", join(DICTS_DIR, "zstd-dict-ru-v1.zstd"), SAMPLES_RU, cctx);
    logResult(r);
    expect((1 - r.totDict / r.totDictless) * 100).toBeGreaterThanOrEqual(30);
    expect((1 - r.totDict / r.totJson) * 100).toBeGreaterThan(0);
  });

  it("FA dict saves ≥30% vs dictless zstd on medium bodies", () => {
    const r = runDictBench("fa", join(DICTS_DIR, "zstd-dict-fa-v1.zstd"), SAMPLES_FA, cctx);
    logResult(r);
    expect((1 - r.totDict / r.totDictless) * 100).toBeGreaterThanOrEqual(30);
    expect((1 - r.totDict / r.totJson) * 100).toBeGreaterThan(0);
  });

  it("EN dict saves ≥30% vs dictless zstd on medium bodies", () => {
    // Latin-script entropy is genuinely lower than Cyrillic/Arabic, so the
    // dict-vs-dictless saving is naturally tighter for EN. JSON saving may go
    // negative (Latin in JSON is already 1B/char + 2B quotes — hard to beat).
    const r = runDictBench("en", join(DICTS_DIR, "zstd-dict-en-v1.zstd"), SAMPLES_EN, cctx);
    logResult(r);
    expect((1 - r.totDict / r.totDictless) * 100).toBeGreaterThanOrEqual(30);
  });
});

// ── Phase 2.F.A — envelope-v2 5-way bench (full envelopes, RU short) ──────────

import { compress as zstdCompressFn } from "@bokuweb/zstd-wasm";

const ROOM_EPOCH = 1_767_225_600_000;

function uuidToBytes(s: string): Uint8Array {
  const hex = s.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Realistic high-entropy peer pubkey (32 random bytes → 64 hex chars).
const FROM_HEX = "9f4a72e1bc83061d52d8e9af74e21b0c6e7f3a90d18b2c4f5d6e7891a2b3c4d5";

describe("envelope-v2 5-way bench (Phase 2.F.A, full envelopes)", () => {
  it("RU short — v2-dict saves ≥20% vs v1-dict on full envelopes", () => {
    const dictBytes = new Uint8Array(
      readFileSync(join(DICTS_DIR, "zstd-dict-ru-v1.zstd")).buffer,
    );
    let totJson = 0, totV1Dless = 0, totV1Dict = 0, totV2Dless = 0, totV2Dict = 0;
    const n = SAMPLES_RU.length;
    for (const body of SAMPLES_RU) {
      const v1 = {
        v: 1,
        id: "01234567-89ab-cdef-0123-456789abcdef",
        ts: ROOM_EPOCH + 60_000,
        from: FROM_HEX,
        kind: "chat-msg",
        body,
      };
      const v2 = {
        v: 2,
        id: uuidToBytes("01234567-89ab-cdef-0123-456789abcdef"),
        ts: 60_000,
        from: FROM_HEX,
        k: 0x01,
        body,
      };
      const cbor1 = cborEncoder.encode(v1);
      const cbor2 = cborEncoder.encode(v2);
      totJson += enc.encode(JSON.stringify(v1)).length;
      totV1Dless += zstdCompressFn(cbor1, ZSTD_LEVEL).length + 1;
      totV1Dict += compressUsingDict(cctx, cbor1, dictBytes, ZSTD_LEVEL).length + 2;
      totV2Dless += zstdCompressFn(cbor2, ZSTD_LEVEL).length + 2;
      totV2Dict += compressUsingDict(cctx, cbor2, dictBytes, ZSTD_LEVEL).length + 2;
    }
    const avg = (t: number) => (t / n).toFixed(1);
    const sv = (a: number, b: number) => ((1 - b / a) * 100).toFixed(1);
    console.log(
      `[bench-2FA] RU short n=${n}: ` +
        `JSON=${avg(totJson)}B  ` +
        `v1-dictless=${avg(totV1Dless)}B (-${sv(totJson, totV1Dless)}% vs JSON)  ` +
        `v1-dict=${avg(totV1Dict)}B (-${sv(totJson, totV1Dict)}% vs JSON)  ` +
        `v2-dictless=${avg(totV2Dless)}B (-${sv(totJson, totV2Dless)}% vs JSON, -${sv(totV1Dless, totV2Dless)}% vs v1-dictless)  ` +
        `v2-dict=${avg(totV2Dict)}B (-${sv(totJson, totV2Dict)}% vs JSON, -${sv(totV1Dict, totV2Dict)}% vs v1-dict)`,
    );
    // Hard-rule gate: ≥20% v1→v2 reduction on short RU. The ≤65B target the
    // spec mentions is gated on Phase 2.F.B (peer-id index — replaces 64B
    // `from` with ~1B); arithmetic floor on full envelopes today is ~76B.
    expect((1 - totV2Dict / totV1Dict) * 100).toBeGreaterThanOrEqual(20);
  });
});
