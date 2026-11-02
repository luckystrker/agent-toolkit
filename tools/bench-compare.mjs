#!/usr/bin/env node
// agent-toolkit bench-compare — «замер скорости» поезда в прод.
// Сравнивает свежие замеры с базовой линией; регрессия больше порога → exit 2
// («медленнее на 10 % — не выкатываем»). Node ≥ 18, без зависимостей.
//
//   node bench-compare.mjs <current.json> [--baseline .agents/bench-baseline.json]
//                          [--max-regression 10] [--update-baseline]
//
// Формат замеров (оба файла): объект «метрика → число» или «метрика → {value, better}»,
// где better = "lower" (по умолчанию: время, память, размер) или "higher" (rps, throughput).
//   { "api_p95_ms": 120, "rps": { "value": 850, "better": "higher" } }
//
// Коды: 0 — в пределах порога (или базовой линии ещё нет — она создаётся из текущих
// замеров с предупреждением), 2 — регрессия, 1 — ошибка входа.
// --update-baseline: записать текущие замеры как новую базовую линию (только после
// осознанного решения, что новая скорость — норма; обычно это делает человек).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const VALUED = new Set(["baseline", "max-regression"]);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
  const k = argv[i].slice(2);
  opts[k] = VALUED.has(k) ? argv[++i] : true;
}
const currentPath = positional[0];
const baselinePath = opts.baseline || ".agents/bench-baseline.json";
const maxRegression = Number(opts["max-regression"] ?? process.env.BENCH_MAX_REGRESSION_PCT ?? 10);
if (!Number.isFinite(maxRegression)) { console.error("[bench] --max-regression: нужно число"); process.exit(1); }

if (!currentPath) { console.error("использование: bench-compare <current.json> [--baseline <файл>] [--max-regression 10] [--update-baseline]"); process.exit(1); }

function load(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`[bench] не читается ${path}: ${e.message}`); process.exit(1); }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = typeof v === "number" ? v : v?.value;
    const better = typeof v === "object" && v?.better === "higher" ? "higher" : "lower";
    if (typeof value !== "number" || !Number.isFinite(value)) { console.error(`[bench] метрика ${k}: не число`); process.exit(1); }
    out[k] = { value, better };
  }
  return out;
}

const current = load(currentPath);
const save = () => { mkdirSync(dirname(baselinePath), { recursive: true }); writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(Object.entries(current).map(([k, m]) => [k, m.better === "higher" ? m : m.value])), null, 2) + "\n"); };

if (opts["update-baseline"]) { save(); console.log(`[bench] базовая линия обновлена: ${baselinePath}`); process.exit(0); }
if (!existsSync(baselinePath)) {
  save();
  console.error(`[bench] базовой линии не было — создана из текущих замеров (${baselinePath}). Сравнивать пока не с чем.`);
  process.exit(0);
}

const baseline = load(baselinePath);
let regressed = 0;
console.log(`метрика`.padEnd(28) + `было`.padStart(12) + `стало`.padStart(12) + `хуже на`.padStart(10));
for (const [k, b] of Object.entries(baseline)) {
  const c = current[k];
  if (!c) { console.log(`${k.padEnd(28)}${String(b.value).padStart(12)}${"—".padStart(12)}   (нет в замере)`); regressed++; continue; }
  // «хуже на X %»: для lower — рост, для higher — падение
  // база 0: любое ухудшение — бесконечная регрессия, а не «0 %»
  const delta = b.better === "higher" ? b.value - c.value : c.value - b.value;
  const worse = b.value === 0 ? (delta > 0 ? Infinity : 0) : (delta / Math.abs(b.value)) * 100;
  const flag = worse > maxRegression ? "  ✗ РЕГРЕССИЯ" : "";
  if (flag) regressed++;
  console.log(`${k.padEnd(28)}${String(b.value).padStart(12)}${String(c.value).padStart(12)}${`${worse.toFixed(1)}%`.padStart(10)}${flag}`);
}
for (const k of Object.keys(current)) if (!baseline[k]) console.log(`${k.padEnd(28)}${"—".padStart(12)}${String(current[k].value).padStart(12)}   (новая метрика)`);

if (regressed) {
  console.error(`\n[bench] ${regressed} метрик(и) хуже базовой линии больше чем на ${maxRegression}% (или пропали) — не выкатываем.`);
  process.exit(2);
}
console.log(`\n[bench] в пределах порога ${maxRegression}%.`);
