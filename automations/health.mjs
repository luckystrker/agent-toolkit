#!/usr/bin/env node
// Автоматизация «Здоровье фабрики» (ежедневно). Проверяет то, что ломается молча:
//   1. тесты тулкита зелёные (npm test в репозитории тулкита);
//   2. TLC и java на месте (иначе модели TLA+ в проектах блокируют коммиты);
//   3. модели агентов из factory.json доступны у своих bb-провайдеров;
//   4. глобальная установка совпадает с репозиторием (никто не правил ~/.claude руками,
//      свежие правки тулкита доставлены).
// Всё в порядке — пустой вывод (тихий тик). Есть проблемы — отчёт в вывод и тред-оркестратор
// на починку; та же самая проблема повторно тред не заводит (иначе — по треду в день).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bbJson, hash, readState, spawnOrchestrator, writeState } from "./lib.mjs";

const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const atk = join(homedir(), ".agent-toolkit");
const problems = [];
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: kit, encoding: "utf8", timeout: 600_000, ...opts });

// 1. тесты
const t = run("npm", ["test", "--silent"]);
if (t.status !== 0) {
  const lines = (t.stdout + t.stderr).split("\n").filter((l) => /^not ok|^# (pass|fail)|Error/.test(l)).slice(0, 25);
  problems.push(`Тесты тулкита красные (npm test, код ${t.status}):\n${lines.join("\n")}`);
}

// 2. TLC
const tlc = join(atk, "bin", "tlc.mjs");
if (!existsSync(tlc)) problems.push("Нет ~/.agent-toolkit/bin/tlc.mjs — глобальная установка неполная.");
else {
  const w = run(process.execPath, [tlc, "--where"]);
  if (w.status !== 0) problems.push(`TLC не готов к работе:\n${w.stdout.trim()}`);
}

// 3. модели агентов
const cfgPath = join(atk, "factory.json");
let workers = {};
try { workers = JSON.parse(readFileSync(cfgPath, "utf8")).workers ?? {}; } catch (e) { problems.push(`${cfgPath} не читается: ${e.message}`); }
const byProvider = {};
for (const [name, w] of Object.entries(workers)) {
  if (!w) continue;
  if (!(w.provider in byProvider)) {
    const d = bbJson(["provider", "models", w.provider]);
    const list = Array.isArray(d) ? d : d?.models ?? null;
    byProvider[w.provider] = list ? new Set(list.map((m) => m.id ?? m.model)) : null;
  }
  const ids = byProvider[w.provider];
  if (ids === null) problems.push(`Агент «${name}»: провайдер ${w.provider} не отвечает (bb provider models ${w.provider}).`);
  else if (!ids.has(w.model)) problems.push(`Агент «${name}»: модели ${w.model} нет у провайдера ${w.provider} — исполнение/проверка на ней упадут.`);
}
if (new Set(Object.values(workers).filter(Boolean).map((w) => w.model)).size < 2)
  problems.push("В factory.json меньше двух агентов на разных моделях — перекрёстная проверка невозможна.");

// 4. расхождение установки с репозиторием (dry-run: «+» = было бы изменено)
const dry = run(process.execPath, [join(kit, "install.mjs"), "--claude-hook", "--profile", "--dry-run"]);
const drift = dry.stdout.split("\n").filter((l) => /^\s+\+ /.test(l) && !/tla2tools/.test(l));
if (drift.length) problems.push(`Глобальная установка расходится с репозиторием тулкита (${drift.length}):\n${drift.slice(0, 15).join("\n")}\nЛечится: node ${join(kit, "install.mjs")} --claude-hook --profile — но сначала выясни, не правил ли владелец эти файлы руками.`);

if (problems.length === 0) { writeState("health-last.json", { ok: true, at: new Date().toISOString() }); process.exit(0); }

const report = problems.map((p, i) => `${i + 1}. ${p}`).join("\n\n");
const key = hash(problems.map((p) => p.split("\n")[0]).join("|"));
const last = readState("health-last.json", {});
console.log(`[здоровье фабрики] проблем: ${problems.length}\n\n${report}`);
if (last.key === key) { console.log(`\n(те же проблемы, что и ${last.at}; тред уже заведён: ${last.thread ?? "—"})`); process.exit(0); }

const spawned = spawnOrchestrator({
  title: `Здоровье фабрики: ${problems.length} проблем(ы)`,
  prompt: `Ежедневная автоматическая проверка тулкита agent-toolkit (${kit}) нашла проблемы. Ты — оркестратор (роль из CLAUDE.md).

${report}

Что сделать:
1. Разберись в причине каждой проблемы по фактам (команды и их вывод), не по догадке.
2. Чинить — по конвейеру: мелочь — сам, остальное — исполнители через factory, проверка другим агентом. Коммит — через гейт.
3. Пуш, изменение состава агентов, всё, что трогает деньги/доступы, — только с согласия владельца: спроси его одним пакетом вопросов.
4. Причина повторяемая — запиши урок (скилл correct) для еженедельной рефлексии.
Доложи владельцу коротко: что было сломано, что починено (с доказательствами), что ждёт его решения.`,
});
writeState("health-last.json", { ok: false, key, at: new Date().toISOString(), thread: spawned.thread ?? null });
console.log(spawned.ok ? `\nЗаведён тред на починку: ${spawned.thread}` : `\nТред завести не удалось: ${spawned.error}`);
process.exit(spawned.ok ? 0 : 1);
