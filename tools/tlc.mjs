#!/usr/bin/env node
// agent-toolkit tlc — проверка моделей TLA+ модель-чекером TLC. Node ≥ 18, без зависимостей.
//
//   tlc                        все модели проекта: spec/tla/**/<Имя>.tla, у которых рядом есть <Имя>.cfg
//   tlc <Имя>.tla [...]        указанные модели (конфиг — <Имя>.cfg рядом)
//   tlc --find                 только показать найденные модели (код 0 — есть, 4 — нет)
//   tlc --where                где взяты java и tla2tools.jar
//
// Ищет java: $JAVA → `java` в PATH → ~/java/*/bin/java.
// Ищет tla2tools.jar: $TLA2TOOLS → <репо>/.agents/tla/tla2tools.jar → ~/.agent-toolkit/tla/tla2tools.jar.
// Служебные файлы TLC (states/) пишутся во временный каталог — в репозитории не остаётся мусора,
// который гейт счёл бы расхождением дерева.
//
// Коды выхода: 0 — все модели прошли; 1 — нарушение инварианта, зависание или ошибка в модели
// (подробности и трасса — в выводе); 2 — нечем проверять (нет java или tla2tools.jar):
// для фичи с инвариантами это блок, а не «пропустим»; 4 — моделей нет (--find).

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const files = argv.filter((a) => !a.startsWith("--"));
const timeoutMs = (Number(process.env.AGENT_TOOLKIT_TLC_TIMEOUT_SEC) || 600) * 1000;

const root = (() => {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
})();

function findJava() {
  if (process.env.JAVA && existsSync(process.env.JAVA)) return process.env.JAVA;
  if (spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0) return "java";
  const base = join(homedir(), "java");
  if (existsSync(base)) {
    for (const d of readdirSync(base).sort().reverse()) {
      const j = join(base, d, "bin", process.platform === "win32" ? "java.exe" : "java");
      if (existsSync(j)) return j;
    }
  }
  return null;
}
function findJar() {
  for (const p of [process.env.TLA2TOOLS, join(root, ".agents", "tla", "tla2tools.jar"), join(homedir(), ".agent-toolkit", "tla", "tla2tools.jar")]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

// модели: spec/tla/**/X.tla с X.cfg рядом (модуль без конфига — вспомогательный, его EXTENDS'ят)
function discover() {
  const top = join(root, "spec", "tla");
  if (!existsSync(top)) return [];
  const out = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (n !== "states") walk(p); }
      else if (n.endsWith(".tla") && existsSync(p.replace(/\.tla$/, ".cfg"))) out.push(p);
    }
  };
  walk(top);
  return out.sort();
}

const models = files.length ? files.map((f) => resolve(f)) : discover();

if (flags.has("--find")) {
  for (const m of models) console.log(relative(root, m));
  process.exit(models.length ? 0 : 4);
}
const java = findJava();
const jar = findJar();
if (flags.has("--where")) {
  console.log(`java: ${java ?? "не найдена"}\ntla2tools.jar: ${jar ?? "не найден"}`);
  process.exit(java && jar ? 0 : 2);
}
if (models.length === 0) { console.log("[tlc] моделей нет (spec/tla/**/<Имя>.tla + <Имя>.cfg) — проверять нечего"); process.exit(0); }
if (!java || !jar) {
  console.error(
    `[tlc] нечем проверить ${models.length} модел(и): ${!java ? "нет java" : ""}${!java && !jar ? " и " : ""}${!jar ? "нет tla2tools.jar" : ""}.\n` +
    `Без формальной проверки код с инвариантами не принимается. Установи: node <agent-toolkit>/install.mjs (кладёт TLC в ~/.agent-toolkit/tla/),\n` +
    `или укажи пути: JAVA=<путь к java> TLA2TOOLS=<путь к tla2tools.jar>.`
  );
  process.exit(2);
}

let failed = 0;
for (const model of models) {
  const cfg = model.replace(/\.tla$/, ".cfg");
  if (!existsSync(model) || !existsSync(cfg)) { console.error(`[tlc] ${model}: нет файла модели или ${basename(cfg)}`); failed++; continue; }
  const meta = mkdtempSync(join(tmpdir(), "tlc-"));
  const started = Date.now();
  const r = spawnSync(java, ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-metadir", meta, "-config", basename(cfg), basename(model)], {
    cwd: dirname(model), encoding: "utf8", timeout: timeoutMs,
  });
  rmSync(meta, { recursive: true, force: true });
  const out = (r.stdout || "") + (r.stderr || "");
  const states = out.match(/(\d[\d,]*) distinct states found/)?.[1];
  const rel = relative(root, model);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.error?.code === "ETIMEDOUT") { console.error(`✗ ${rel}: не уложился в ${timeoutMs / 1000} с — уменьши константы модели`); failed++; continue; }
  if (r.status === 0 && /No error has been found/.test(out)) { console.log(`✓ ${rel}: инварианты держатся (${states ?? "?"} состояний, ${secs} с)`); continue; }
  failed++;
  const reason = out.match(/Error: (Invariant \S+ is violated|Deadlock reached|Temporal properties were violated|.*)/)?.[1] ?? `TLC вернул код ${r.status}`;
  console.error(`✗ ${rel}: ${reason}\n${out.split("\n").filter((l) => /^(Error|State \d+|\/\\|  )/.test(l)).slice(0, 60).join("\n")}`);
}
console.log(failed ? `\n[tlc] не прошло: ${failed} из ${models.length}` : `\n[tlc] все модели прошли: ${models.length}`);
process.exit(failed ? 1 : 0);
