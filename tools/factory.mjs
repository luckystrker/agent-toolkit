#!/usr/bin/env node
// agent-toolkit factory — запуск ролей конвейера как bb-тредов (оркестрация средствами bb).
// Node ≥ 18, без зависимостей.
//
// Две оси, не смешанные друг с другом:
//   • РОЛИ — что делать: executor, verifier, tester, critic (промпты roles/<роль>.md, в коде);
//   • АГЕНТЫ (workers) — кто делает: bb-провайдер (харнесс) + модель, только в factory.json.
// Любой агент играет любую роль. Конкретные модели и подписки — дело конфига: у кого OpenAI —
// два агента на Codex с разными моделями, у кого Claude и OpenCode — по агенту на каждом.
//
//   factory workers                                    агенты, их роли и счёт задач в этом треде
//   factory spawn executor [--worker <имя>] --task <файл|-> [--title "..."] [--dry-run]
//   factory spawn verifier|tester|critic --executor <thread-id> [--worker <имя>] --task <файл|->
//   factory env <thread-id>                            окружение треда: id, путь, ветка
//
// Правила, которые проверяет код:
//   - executor без --worker → агент с наименьшим числом исполнений у текущего оркестратора
//     (поровну, при равенстве — по порядку в конфиге);
//   - проверяющие роли — только в окружении исполнителя и только агентом, который НЕ исполнял
//     и работает на ДРУГОЙ модели (перекрёстная проверка); таких нет — отказ (код 3);
//   - исполнитель — в новом git worktree, проверяющие — в его окружении (видят его дифф).
// Тред создаётся дочерним к текущему (--parent-self): bb будит оркестратора итогом.
//
// Конфигурация (поздний перекрывает ранний; агент со значением null — убрать):
//   <каталог скрипта>/../factory.json   (~/.agent-toolkit/factory.json или .agents/factory.json)
//   <корень репозитория>/.agents/factory.json
//   { "workers": { "<имя>": { "provider": "<bb-провайдер>", "model": "<модель>",
//       "reasoning": "high", "permission": "auto", "strengths": "<подсказка оркестратору>" } } }
//   Провайдеры и модели машины: `bb provider list`, `bb provider models <провайдер>`.
// Журнал запусков (кто исполнял какой тред): ~/.agent-toolkit/state/threads.jsonl.
//
// Коды выхода: 0 — ок; 1 — ошибка вызова/конфигурации; 3 — нарушено правило конвейера;
// другие — код выхода bb.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const kitDir = resolve(scriptDir, "..");
const ROLES = ["executor", "verifier", "tester", "critic"];
const REVIEWING = ["verifier", "tester", "critic"];
const statePath = join(process.env.AGENT_TOOLKIT_STATE_DIR || join(homedir(), ".agent-toolkit", "state"), "threads.jsonl");

function die(msg, code = 1) { console.error(`[factory] ${msg}`); process.exit(code); }

// --- аргументы ---
const argv = process.argv.slice(2);
const VALUED = new Set(["task", "title", "project", "executor", "worker"]);
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
function loadWorkers() {
  const files = [join(kitDir, "factory.json")];
  const root = gitRoot();
  if (root) files.push(join(root, ".agents", "factory.json"));
  const workers = {};
  for (const f of [...new Set(files)]) {
    if (!existsSync(f)) continue;
    let c;
    try { c = JSON.parse(readFileSync(f, "utf8")); } catch (e) { die(`${f} не парсится: ${e.message}`); }
    if (c.roles && !c.workers)
      die(`${f}: старый формат (roles с моделями). Теперь модели — в "workers": { "<имя>": { "provider", "model", ... } }; роли зашиты в коде. Образец — factory.json тулкита`);
    for (const [name, w] of Object.entries(c.workers ?? {})) {
      if (w === null) { delete workers[name]; continue; }
      workers[name] = { ...(workers[name] ?? {}), ...w };
    }
  }
  const list = Object.entries(workers);
  if (list.length === 0) die(`нет агентов: опиши "workers" в factory.json (${files.join(", ")})`);
  for (const [name, w] of list) if (!w.provider || !w.model) die(`агент «${name}»: нужны provider и model`);
  return workers;
}

// --- журнал запусков ---
function readState() {
  if (!existsSync(statePath)) return [];
  return readFileSync(statePath, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
function record(entry) {
  mkdirSync(dirname(statePath), { recursive: true });
  appendFileSync(statePath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}
const parent = process.env.BB_THREAD_ID || null;
// счёт ведём в пределах текущего оркестратора: «поровну» — между задачами одной работы
const usage = (role) => {
  const counts = {};
  for (const e of readState()) if (e.parent === parent && e.role === role) counts[e.worker] = (counts[e.worker] ?? 0) + 1;
  return counts;
};
const leastUsed = (names, role) => {
  const c = usage(role);
  return [...names].sort((a, b) => (c[a] ?? 0) - (c[b] ?? 0))[0]; // sort стабилен: при равенстве — порядок конфига
};

// кто исполнял тред: журнал → метка [агент] в заголовке → единственный агент на этом провайдере
function executorOf(threadId, workers) {
  const logged = readState().filter((e) => e.thread === threadId && e.role === "executor").pop();
  const res = bb(["thread", "show", threadId, "--json"]);
  if (res.status !== 0) die(`не читается тред исполнителя ${threadId}: ${(res.stderr || res.stdout).trim()}`);
  const t = JSON.parse(res.stdout).thread ?? {};
  let name = logged?.worker;
  if (!name) name = String(t.title ?? "").match(/^executor\[([^\]]+)\]/)?.[1];
  if (!name) {
    const same = Object.entries(workers).filter(([, w]) => w.provider === t.providerId).map(([n]) => n);
    if (same.length === 1) name = same[0];
  }
  if (!name) die(`не знаю, какой агент исполнял ${threadId} (провайдер ${t.providerId}): его запускали не через factory. Укажи проверяющего явно: --worker <имя>`, 3);
  const w = workers[name] ?? (logged ? { provider: logged.provider, model: logged.model } : null);
  if (!w) die(`исполнитель ${threadId} — агент «${name}», которого нет в factory.json`, 3);
  return { name, worker: w, environment: t.environmentId };
}

// финальный отчёт исполнителя дословно из лога bb: проверяющий сверяет ЕГО утверждения,
// а не пересказ оркестратора (пересказ теряет как раз то, что исполнитель приврал)
function finalReport(threadId) {
  const res = bb(["thread", "log", threadId, "--json", "--all"]);
  if (res.status !== 0) return null;
  let events;
  try { events = JSON.parse(res.stdout); } catch { return null; }
  let text = null;
  for (const e of Array.isArray(events) ? events : []) {
    const it = e?.data?.item ?? e?.data;
    if (e?.type === "item/completed" && it?.type === "agentMessage" && typeof it.text === "string" && it.text.trim()) text = it.text;
  }
  return text;
}

// --- команды ---
const commands = {
  workers() {
    const workers = loadWorkers();
    const ex = usage("executor");
    const rv = {};
    for (const r of REVIEWING) for (const [n, k] of Object.entries(usage(r))) rv[n] = (rv[n] ?? 0) + k;
    for (const [name, w] of Object.entries(workers))
      console.log(`${name.padEnd(12)} ${w.provider}  ${w.model}  усилие=${w.reasoning ?? "по умолчанию"}` +
        `${w.strengths ? `  сильные стороны: ${w.strengths}` : ""}  [исполнял: ${ex[name] ?? 0}, проверял: ${rv[name] ?? 0}]`);
    const models = new Set(Object.values(workers).map((w) => w.model));
    if (models.size < 2) console.error("[factory] внимание: все агенты на одной модели — перекрёстная проверка невозможна. Добавь агента на другой модели.");
  },
  roles() { commands.workers(); },

  spawn() {
    const role = rest[0] ?? die(`factory spawn <${ROLES.join("|")}> --task <файл|->`);
    if (!ROLES.includes(role)) die(`роль ${role} неизвестна (есть: ${ROLES.join(", ")}); агенты (модели) — в factory.json: workers`);
    const workers = loadWorkers();
    if (opts.worker && !workers[opts.worker]) die(`агента «${opts.worker}» нет в factory.json (есть: ${Object.keys(workers).join(", ")})`);
    if (!opts.task) die("--task <файл|-> обязателен: задача роли (цель, финишная черта, швы, «не трогать»)");
    const task = opts.task === "-" ? readFileSync(0, "utf8") : readFileSync(opts.task, "utf8");
    if (!task.trim()) die("задача пустая");

    let workerName;
    let environment = null;
    let reviewed = null;
    if (role === "executor") {
      workerName = opts.worker || leastUsed(Object.keys(workers), "executor");
    } else {
      if (!opts.executor) die(`роль ${role} проверяет чужую работу: --executor <thread-id исполнителя> обязателен`, 3);
      reviewed = executorOf(opts.executor, workers);
      environment = reviewed.environment;
      if (!environment) die(`у треда исполнителя ${opts.executor} нет окружения`, 3);
      // перекрёстно: не тот агент и не та модель
      const others = Object.entries(workers).filter(([n, w]) => n !== reviewed.name && w.model !== reviewed.worker.model).map(([n]) => n);
      if (opts.worker && !others.includes(opts.worker))
        die(`агент «${opts.worker}» не может проверять работу «${reviewed.name}»: проверяет всегда другой агент на другой модели`, 3);
      if (others.length === 0)
        die(`работу «${reviewed.name}» (${reviewed.worker.model}) проверить некому: нужен второй агент на другой модели в factory.json → workers`, 3);
      workerName = opts.worker || leastUsed(others, role);
      reviewed.report = finalReport(opts.executor);
    }
    const w = workers[workerName];

    const rolePromptPath = join(kitDir, "roles", `${role}.md`);
    if (!existsSync(rolePromptPath)) die(`нет промпта роли: ${rolePromptPath}`);
    const project = opts.project || process.env.BB_PROJECT_ID;
    if (!project) die("нет проекта: запускай из bb-треда (BB_PROJECT_ID) или передай --project <id>");

    const prompt = [
      readFileSync(rolePromptPath, "utf8").trim(),
      "",
      "## Задача",
      task.trim(),
      "",
      "## Как ты запущен",
      `Ты — роль «${role}», агент «${workerName}» (${w.model}) в bb-треде${parent ? `, дочернем к оркестратору @thread:${parent}` : ""}.`,
      ...(reviewed ? [`Работу делал агент «${reviewed.name}» (${reviewed.worker.model}) в треде @thread:${opts.executor} — перекрёстная проверка.`] : []),
      ...(reviewed ? ["", "## Отчёт исполнителя — дословно, из bb",
        reviewed.report
          ? `${reviewed.report.trim()}\n\n(Каждое утверждение этого отчёта — строка в твоей таблице, включая побочные: «гейта нет», «скрипта нет», «ничего не менял». Пересказ оркестратора в «Задаче» отчёт не заменяет.)`
          : `Отчёт не найден в логе треда — прочитай его сам: \`bb thread log ${opts.executor}\`; не нашёл — «не подтверждено» по всем пунктам.`] : []),
      "Твой финальный ответ bb передаст оркестратору — это и есть твой отчёт: факты, команды и их фактический вывод, без «должно работать».",
      "Вопрос, без ответа на который нельзя продолжать, — задай его оркестратору финальным ответом и остановись.",
    ].join("\n");

    const promptFile = join(mkdtempSync(join(tmpdir(), "factory-")), "prompt.md");
    writeFileSync(promptFile, prompt);
    const title = opts.title || task.trim().split("\n")[0].slice(0, 60);
    const args = ["thread", "spawn", "--project", project, "--provider", w.provider, "--model", w.model,
      "--title", `${role}[${workerName}]: ${title}`, "--prompt-file", promptFile, "--json"];
    if (parent) args.push("--parent-self");
    if (w.reasoning) args.push("--reasoning-level", w.reasoning);
    if (w.permission) args.push("--permission-mode", w.permission);
    if (environment) args.push("--environment", environment);
    else args.push("--new-environment", "worktree");

    if (opts["dry-run"]) { console.log(JSON.stringify({ role, worker: workerName, reviewing: reviewed?.name ?? null, bb: args, prompt }, null, 2)); return; }
    const res = bb(args);
    if (res.status !== 0) { process.stderr.write(res.stderr || res.stdout); process.exit(res.status || 1); }
    let thread;
    try { thread = JSON.parse(res.stdout); } catch { thread = { raw: res.stdout.trim() }; }
    record({ thread: thread.id, role, worker: workerName, provider: w.provider, model: w.model, parent, environment: thread.environmentId ?? environment, reviewing: opts.executor ?? null });
    console.log(JSON.stringify({ role, worker: workerName, model: w.model, reviewing: reviewed?.name ?? null, thread: thread.id, environment: thread.environmentId ?? environment, title: thread.title }, null, 2));
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
