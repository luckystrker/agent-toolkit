#!/usr/bin/env node
// agent-toolkit factory — запуск ролей конвейера как bb-тредов (оркестрация средствами bb).
// Node ≥ 18, без зависимостей. Оркестратор (главная сессия) вызывает этот скрипт, а не
// собирает `bb thread spawn` руками: модель, провайдер, усилие и окружение роли берутся из
// конфигурации, правило «проверяет другая модель» проверяется кодом, а не словами.
//
//   factory roles                                   роли → провайдер/модель/окружение
//   factory spawn <role> --task <файл|-> [--env <id|путь>] [--title "..."] [--dry-run]
//   factory env <thread-id>                         окружение треда: id, путь, ветка
//
// Роли и окружения по умолчанию:
//   executor  — новый git worktree (каждый исполнитель изолирован, параллель безопасна)
//   verifier, tester, critic — --env обязателен: окружение исполнителя (видят его дифф)
// Тред создаётся дочерним к текущему (--parent-self): bb будит оркестратора, когда он
// закончил ход, упал или ждёт ответа; итог роли — её финальный ответ.
//
// Конфигурация (поздний перекрывает ранний):
//   <каталог скрипта>/../factory.json   (~/.agent-toolkit/factory.json или .agents/factory.json)
//   <корень репозитория>/.agents/factory.json
// Промпты ролей: <каталог скрипта>/../roles/<role>.md
//
// Коды выхода: 0 — ок; 1 — ошибка вызова/конфигурации; 3 — нарушено правило конвейера;
// другие — код выхода bb.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const kitDir = resolve(scriptDir, "..");
const VERIFYING = ["verifier", "tester", "critic"];

function die(msg, code = 1) { console.error(`[factory] ${msg}`); process.exit(code); }

// --- аргументы ---
const argv = process.argv.slice(2);
const VALUED = new Set(["task", "env", "title", "project"]);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const k = a.slice(2);
  if (k === "dry-run" || k === "help") opts[k] = true;
  else if (VALUED.has(k)) { if (argv[i + 1] === undefined) die(`--${k} требует значение`); opts[k] = argv[++i]; }
  else die(`неизвестный флаг --${k}`);
}
const [cmd, ...rest] = positional;

// --- bb ---
// голый `bb` перезапускает себя через $BB_CLI; если у того файла нет бита исполнения,
// команда молча ничего не делает — поэтому node-скрипт BB_CLI запускаем через node явно
function bbCommand() {
  const cli = process.env.BB_CLI;
  if (cli && existsSync(cli)) {
    const head = readFileSync(cli, "utf8").slice(0, 64);
    return head.startsWith("#!") && head.includes("node") ? [process.execPath, cli] : [cli];
  }
  return ["bb"];
}
function bb(args) {
  const [exe, ...pre] = bbCommand();
  return spawnSync(exe, [...pre, ...args], { encoding: "utf8" });
}

// --- конфигурация ---
function gitRoot() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
function loadConfig() {
  const files = [join(kitDir, "factory.json")];
  const root = gitRoot();
  if (root) files.push(join(root, ".agents", "factory.json"));
  const roles = {};
  for (const f of [...new Set(files)]) {
    if (!existsSync(f)) continue;
    let c;
    try { c = JSON.parse(readFileSync(f, "utf8")); } catch (e) { die(`${f} не парсится: ${e.message}`); }
    for (const [name, r] of Object.entries(c.roles ?? {})) roles[name] = { ...(roles[name] ?? {}), ...r, source: f };
  }
  if (Object.keys(roles).length === 0) die(`нет конфигурации ролей (${files.join(", ")})`);
  return roles;
}
function checkModels(roles) {
  const exec = roles.executor?.model;
  for (const r of VERIFYING) {
    if (roles[r] && exec && roles[r].model === exec)
      die(`роль ${r} на той же модели, что исполнитель (${exec}) — проверяет всегда другая модель. Поправь factory.json`, 3);
  }
}

// --- команды ---
const commands = {
  roles() {
    const roles = loadConfig();
    checkModels(roles);
    for (const [name, r] of Object.entries(roles))
      console.log(`${name.padEnd(9)} ${r.provider}  ${r.model}  усилие=${r.reasoning ?? "по умолчанию"}  окружение=${r.environment ?? "new-worktree"}`);
  },

  spawn() {
    const role = rest[0] ?? die("factory spawn <role> --task <файл|-> [--env <id>]");
    const roles = loadConfig();
    checkModels(roles);
    const r = roles[role] ?? die(`роль ${role} не описана в factory.json (есть: ${Object.keys(roles).join(", ")})`);
    if (!r.provider || !r.model) die(`роль ${role}: нужны provider и model`);
    const rolePromptPath = join(kitDir, "roles", `${role}.md`);
    if (!existsSync(rolePromptPath)) die(`нет промпта роли: ${rolePromptPath}`);
    if (!opts.task) die("--task <файл|-> обязателен: задача роли (цель, финишная черта, швы, «не трогать»)");
    const task = opts.task === "-" ? readFileSync(0, "utf8") : readFileSync(opts.task, "utf8");
    if (!task.trim()) die("задача пустая");

    const envMode = r.environment ?? (VERIFYING.includes(role) ? "same" : "new-worktree");
    if (envMode === "same" && !opts.env)
      die(`роль ${role} работает в окружении исполнителя: --env <environment-id> (узнать: factory env <thread-исполнителя>)`, 3);

    const project = opts.project || process.env.BB_PROJECT_ID;
    if (!project) die("нет проекта: запускай из bb-треда (BB_PROJECT_ID) или передай --project <id>");
    const parent = process.env.BB_THREAD_ID;

    const prompt = [
      readFileSync(rolePromptPath, "utf8").trim(),
      "",
      "## Задача",
      task.trim(),
      "",
      "## Как ты запущен",
      `Ты — роль «${role}» (${r.model}) в bb-треде${parent ? `, дочернем к оркестратору @thread:${parent}` : ""}.`,
      "Твой финальный ответ bb передаст оркестратору — это и есть твой отчёт: факты, команды и их фактический вывод, без «должно работать».",
      "Вопрос, без ответа на который нельзя продолжать, — задай его оркестратору финальным ответом и остановись.",
    ].join("\n");

    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, prompt);

    const args = ["thread", "spawn", "--project", project, "--provider", r.provider, "--model", r.model,
      "--title", opts.title || `${role}: ${task.trim().split("\n")[0].slice(0, 60)}`, "--prompt-file", promptFile, "--json"];
    if (parent) args.push("--parent-self");
    if (r.reasoning) args.push("--reasoning-level", r.reasoning);
    if (r.permission) args.push("--permission-mode", r.permission);
    if (envMode === "same") args.push("--environment", opts.env);
    else if (envMode === "new-worktree") args.push("--new-environment", "worktree");
    else die(`роль ${role}: неизвестное environment «${envMode}» (new-worktree | same)`);

    if (opts["dry-run"]) { console.log(JSON.stringify({ bb: args, prompt }, null, 2)); return; }
    const res = bb(args);
    if (res.status !== 0) { process.stderr.write(res.stderr || res.stdout); process.exit(res.status || 1); }
    let thread;
    try { thread = JSON.parse(res.stdout); } catch { thread = { raw: res.stdout.trim() }; }
    console.log(JSON.stringify({ role, model: r.model, thread: thread.id, environment: thread.environmentId ?? opts.env ?? null, title: thread.title }, null, 2));
  },

  env() {
    const id = rest[0] ?? die("factory env <thread-id>");
    const res = bb(["thread", "show", id, "--json"]);
    if (res.status !== 0) { process.stderr.write(res.stderr || res.stdout); process.exit(res.status || 1); }
    const d = JSON.parse(res.stdout);
    const e = d.environment ?? {};
    console.log(JSON.stringify({ thread: id, status: d.thread?.status, environment: e.id ?? d.thread?.environmentId, path: e.path, branch: e.branchName }, null, 2));
  },
};

if (!cmd || cmd === "help" || opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
(commands[cmd] ?? (() => die(`неизвестная команда: ${cmd} (factory help)`)))();
