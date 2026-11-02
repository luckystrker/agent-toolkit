#!/usr/bin/env node
// agent-toolkit board — общая доска задач + общий лог событий для нескольких агентов.
// Node ≥ 18, без зависимостей. Harness-agnostic: любой агент, умеющий запускать
// команды, координируется через файлы в репозитории.
//
// Схемы общения агентов, реализованные локально:
//   • общая доска:   tasks/*.md — тикеты; «кто что взял» — поле owner + lock-файл
//   • стигмергия:    .agents/events.jsonl — общий лог, каждое действие с отправителем
//   • сообщения CLI: msg/inbox поверх того же лога, с лимитом пинг-понга
//
// Правила, которые инструмент проверяет:
//   - отправитель обязателен: --as <агент> (или env AGENT_NAME);
//   - claim атомарен (lock через O_EXCL) и только для тикета с закрытыми зависимостями;
//   - done — только из review и только НЕ исполнителем (owner); при указанных
//     executor_model / verifier_model они обязаны различаться — без исключений для ролей;
//   - human: required переводит в done только --as human, а --as human требует
//     подтверждения в интерактивном терминале (ввод номера тикета);
//   - пинг-понг между двумя агентами ограничен (6 сообщений подряд без смены статуса
//     тикета) — дальше эскалация тимлиду/человеку.
//
// ЧЕСТНО: --as — заявление, а не аутентификация. Проверки защищают от ошибок и
// забывчивости агентов, а не от намеренного обмана (TTY можно эмулировать).
// Настоящий шлюз для необратимого — защита веток и ревью владельца на сервере.
//
// Команды:
//   board list [--status <s>]            таблица тикетов; READY = open и зависимости done
//   board next                            первый ready-тикет по приоритету
//   board show <id>
//   board claim <id> --as <агент>
//   board status <id> <open|claimed|review|done|blocked> --as <агент> [--note "..."]
//   board log "<сообщение>" --as <агент> [--ticket <id>]
//   board msg <кому> "<текст>" --as <агент> [--ticket <id>]
//   board inbox --as <агент> [--all]
//   board events [--tail N] [--ticket <id>]
// Текст, начинающийся с «--», передавай после разделителя: board log --as a -- "--текст"
//
// Коды выхода: 0 — ок; 1 — ошибка вызова/формата тикета; 3 — действие запрещено правилами
// доски или тикет занят; 4 — нет готовых тикетов (next); 5 — лимит пинг-понга.
//
// Окружение: BOARD_ROOT (корень доски; по умолчанию — основной рабочий каталог git,
// общий для всех worktree), BOARD_PINGPONG_LIMIT (6), BOARD_LOCK_STALE_MS (30000).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const STATUSES = ["open", "claimed", "review", "done", "blocked"];
const PINGPONG_LIMIT = Number(process.env.BOARD_PINGPONG_LIMIT) || 6;
const LOCK_STALE_MS = Number(process.env.BOARD_LOCK_STALE_MS) || 30_000;

class BoardError extends Error { constructor(msg, code) { super(msg); this.exitCode = code; } }
// бросаем, а не process.exit: иначе finally в withLock не снимет lock-файл и тикет «залипнет»
function die(msg, code = 1) { throw new BoardError(msg, code); }

// корень доски: у всех worktree одного репозитория — один и тот же (общий .git),
// иначе исполнители в отдельных worktree получили бы каждый свою копию доски
const root = process.env.BOARD_ROOT || (() => {
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (common.status === 0 && common.stdout.trim().endsWith(".git")) return dirname(common.stdout.trim());
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return top.status === 0 ? top.stdout.trim() : process.cwd();
})();
const tasksDir = join(root, "tasks");
const locksDir = join(tasksDir, ".locks");
const eventsPath = join(root, ".agents", "events.jsonl");

// --- аргументы ---

const VALUED = new Set(["as", "ticket", "note", "status", "tail"]);
const BOOLEAN = new Set(["all", "help"]);
const argv = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const k = a.slice(2);
  if (BOOLEAN.has(k)) opts[k] = true;
  else if (VALUED.has(k)) {
    if (argv[i + 1] === undefined) { console.error(`[board] --${k} требует значение`); process.exit(1); }
    opts[k] = argv[++i];
  } else { console.error(`[board] неизвестный флаг --${k} (текст с «--» передавай после разделителя: -- "текст")`); process.exit(1); }
}
const [cmd, ...rest] = positional;

function confirmHuman() {
  // роль человека нельзя просто объявить: нужен интерактивный терминал и ввод подтверждения
  if (!process.stdin.isTTY) die("--as human доступен только человеку в интерактивном терминале; агент — эскалируй: board msg human \"...\"", 3);
  const expected = ["status", "claim"].includes(cmd) && rest[0] ? rest[0] : "да";
  process.stderr.write(`[board] Подтверди как человек: введи «${expected}» и Enter: `);
  const buf = Buffer.alloc(256);
  let n = 0;
  try { n = readSync(0, buf, 0, 256); } catch { n = 0; }
  if (buf.toString("utf8", 0, n).trim() !== String(expected)) die("подтверждение не совпало — действие отменено", 3);
}
function actor() {
  const a = opts.as || process.env.AGENT_NAME;
  if (!a) die("нужен отправитель: --as <агент> (или env AGENT_NAME) — правило «видно отправителя»");
  if (a === "human") confirmHuman();
  return String(a);
}

// --- тикеты ---
// Формат frontmatter — плоский «ключ: значение», списки — в строку: [1, 2].
// Неразобранная строка (block-YAML, отступы) — ошибка, а не молчаливая потеря данных.

function parseTicket(file) {
  const raw = readFileSync(file, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = raw.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { file, meta: {}, lines: [], body: text, eol, hasFrontmatter: false };
  const lines = m[1].split("\n");
  const meta = {};
  let error = null;
  lines.forEach((line, i) => {
    if (error || !line.trim() || line.trim().startsWith("#")) return;
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*(#.*)?$/);
    if (!kv) { error = `${file}:${i + 2}: не разобрал строку frontmatter «${line}». Формат — плоский «ключ: значение», списки в строку: depends_on: [1, 2]`; return; }
    let v = kv[2];
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    meta[kv[1]] = v;
  });
  if (error && !meta.id) meta.id = (file.match(/(\d+)[^/\\]*\.md$/) ?? [])[1] ?? file;
  return { file, meta, lines, body: m[2], eol, hasFrontmatter: true, error };
}

// правим по месту: меняются только затронутые ключи, комментарии и порядок сохраняются;
// запись атомарна (tmp + rename) — читатель никогда не увидит полуфайл
function writeTicket(t, changes) {
  const fmt = (v) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
  const lines = [...t.lines];
  for (const [k, v] of Object.entries(changes)) {
    const idx = lines.findIndex((l) => new RegExp(`^${k}:`).test(l));
    if (v === undefined) { if (idx >= 0) lines.splice(idx, 1); }
    else if (idx >= 0) lines[idx] = `${k}: ${fmt(v)}`;
    else lines.push(`${k}: ${fmt(v)}`);
  }
  const out = `---\n${lines.join("\n")}\n---\n${t.body}`.replace(/\n/g, t.eol);
  const tmp = `${t.file}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, t.file);
}

function loadTickets() {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
    .map((n) => parseTicket(join(tasksDir, n)))
    .filter((t) => t.hasFrontmatter && t.meta.id)
    .sort((a, b) => (Number(a.meta.priority) || 99) - (Number(b.meta.priority) || 99) || String(a.meta.id).localeCompare(String(b.meta.id)));
}

const norm = (id) => String(id).replace(/^0+(?=\d)/, "");
function findTicket(id) {
  const t = loadTickets().find((x) => norm(x.meta.id) === norm(id));
  if (!t) die(`тикет ${id} не найден в ${tasksDir}`);
  if (t.error) die(t.error);
  return t;
}

function depsOf(t) { return Array.isArray(t.meta.depends_on) ? t.meta.depends_on : t.meta.depends_on ? [t.meta.depends_on] : []; }
function openDeps(t, all) {
  return depsOf(t).filter((d) => {
    const dep = all.find((x) => norm(x.meta.id) === norm(d));
    return !dep || dep.error || dep.meta.status !== "done";
  });
}
const isReady = (t, all) => !t.error && (t.meta.status ?? "open") === "open" && openDeps(t, all).length === 0;

// --- лог событий ---

function ensureIgnored() {
  // рантайм доски — локальная координация, не история проекта: в git не попадает,
  // иначе гейт видел бы вечное расхождение дерева с индексом
  const ig = join(root, ".agents", ".gitignore");
  const cur = existsSync(ig) ? readFileSync(ig, "utf8") : "";
  if (!cur.split(/\r?\n/).includes("events.jsonl")) appendFileSync(ig, `${cur && !cur.endsWith("\n") ? "\n" : ""}events.jsonl\n`);
}
function emit(event) {
  mkdirSync(join(root, ".agents"), { recursive: true });
  ensureIgnored();
  appendFileSync(eventsPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}
function readEvents() {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// --- lock ---

function lockIsStale(lock) {
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    const pid = Number(readFileSync(lock, "utf8").split(" ")[0]);
    if (pid) { try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") return true; } }
    return age > LOCK_STALE_MS;
  } catch { return false; }
}

function withLock(id, fn) {
  mkdirSync(locksDir, { recursive: true });
  const ig = join(locksDir, ".gitignore");
  if (!existsSync(ig)) writeFileSync(ig, "*\n");
  const lock = join(locksDir, `${norm(id)}.lock`);
  let fd;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
    try { fd = openSync(lock, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      // упавший агент (SIGKILL, крах) оставил lock — снимаем, если владелец мёртв или lock старый
      if (attempt === 0 && lockIsStale(lock)) { rmSync(lock, { force: true }); continue; }
      die(`тикет ${id} сейчас правит другой агент (${lock}); повтори через пару секунд. Висит дольше ${LOCK_STALE_MS / 1000} с — снимется сам`, 3);
    }
  }
  writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
  try { return fn(); } finally { closeSync(fd); rmSync(lock, { force: true }); }
}

// --- команды ---

const commands = {
  list() {
    const all = loadTickets();
    const filtered = opts.status ? all.filter((t) => (t.meta.status ?? "open") === opts.status) : all;
    if (filtered.length === 0) { console.log(existsSync(tasksDir) ? "(тикетов нет)" : `(нет каталога ${tasksDir} — тикеты создаёт скилл to-tickets)`); return; }
    for (const t of filtered) {
      if (t.error) { console.log(`${String(t.meta.id).padEnd(5)} BROKEN   ${t.error}`); process.exitCode = 1; continue; }
      const s = t.meta.status ?? "open";
      const ready = isReady(t, all) ? " READY" : "";
      const deps = openDeps(t, all);
      console.log(`${String(t.meta.id).padEnd(5)} ${s.padEnd(8)}${ready.padEnd(6)} p${t.meta.priority ?? "-"} ${t.meta.mode ?? ""}  ${t.meta.title ?? ""}` +
        (t.meta.owner ? `  @${t.meta.owner}` : "") + (deps.length && s === "open" ? `  ждёт: ${deps.join(",")}` : ""));
    }
  },
  next() {
    const all = loadTickets();
    const t = all.find((x) => isReady(x, all));
    if (!t) { console.log("(нет готовых к взятию тикетов)"); process.exitCode = 4; return; }
    console.log(`${t.meta.id}\t${t.meta.title ?? ""}\t${t.file}`);
  },
  show() {
    const t = findTicket(rest[0] ?? die("board show <id>"));
    console.log(readFileSync(t.file, "utf8"));
  },
  claim() {
    const id = rest[0] ?? die("board claim <id> --as <агент>");
    const who = actor();
    withLock(id, () => {
      const all = loadTickets();
      const t = findTicket(id);
      const status = t.meta.status ?? "open";
      if (status !== "open") die(`тикет ${id} в статусе ${status}${t.meta.owner ? ` (взял ${t.meta.owner})` : ""} — брать нельзя`, 3);
      const deps = openDeps(t, all);
      if (deps.length) die(`тикет ${id} ждёт незакрытые зависимости: ${deps.join(", ")} (водопад)`, 3);
      writeTicket(t, { status: "claimed", owner: who });
      emit({ agent: who, type: "claim", ticket: String(t.meta.id), msg: t.meta.title ?? "" });
      console.log(`взят: ${t.meta.id} → ${who}`);
    });
  },
  status() {
    const [id, next] = rest;
    if (!id || !STATUSES.includes(next)) die(`board status <id> <${STATUSES.join("|")}> --as <агент>`);
    const who = actor();
    withLock(id, () => {
      const t = findTicket(id);
      const prev = t.meta.status ?? "open";
      const owner = t.meta.owner;
      const boss = ["teamlead", "human"].includes(who);
      if (next === "done") {
        // приёмку делает не исполнитель: только из review и только другим агентом
        if (prev !== "review") die(`тикет ${id}: в done — только из review (сейчас ${prev}). Исполнитель: status ${id} review, принимает другой агент`, 3);
        if (who === owner) die(`тикет ${id}: исполнитель ${who} не принимает свою работу сам — это делает другой агент`, 3);
        if (t.meta.verifier_model && t.meta.executor_model && t.meta.verifier_model === t.meta.executor_model)
          die(`тикет ${id}: модель проверки совпадает с моделью исполнителя (${t.meta.executor_model}) — проверяет всегда другая модель`, 3);
        if (String(t.meta.human ?? "") === "required" && who !== "human")
          die(`тикет ${id} помечен human: required — в done его переводит только человек`, 3);
      } else if (prev === "review") {
        // на проверке исполнитель может только забрать тикет обратно в работу
        if (who === owner && next !== "claimed") die(`тикет ${id} на проверке: исполнитель может только вернуть его в claimed`, 3);
      } else if (owner && who !== owner && !boss && prev !== "open") {
        die(`тикет ${id} принадлежит ${owner}; менять статус может владелец, teamlead или human`, 3);
      }
      writeTicket(t, { status: next, owner: next === "open" ? undefined : owner ?? (next === "claimed" ? who : undefined) });
      emit({ agent: who, type: "status", ticket: String(t.meta.id), msg: `${prev} → ${next}${opts.note ? `: ${opts.note}` : ""}` });
      console.log(`${t.meta.id}: ${prev} → ${next}`);
    });
  },
  log() {
    const msg = rest.join(" ") || die('board log "<сообщение>" --as <агент>');
    emit({ agent: actor(), type: "log", ticket: opts.ticket ? String(opts.ticket) : undefined, msg });
  },
  msg() {
    const [to, ...words] = rest;
    if (!to || words.length === 0) die('board msg <кому> "<текст>" --as <агент>');
    const from = actor();
    if (from === to) die("сообщение самому себе — это log, не msg");
    // пинг-понг: подряд идущие сообщения между этой парой с последнего «прогресса»
    // (смена статуса, claim или слово человека) — дальше эскалация
    let streak = 0;
    for (const e of readEvents().reverse()) {
      if (e.type === "status" || e.type === "claim" || e.agent === "human") break;
      if (e.type === "msg" && ((e.agent === from && e.to === to) || (e.agent === to && e.to === from))) streak++;
    }
    if (streak >= PINGPONG_LIMIT && !["teamlead", "human"].includes(to))
      die(`лимит пинг-понга: ${streak} сообщений между ${from} и ${to} без прогресса. Эскалируй: board msg teamlead "..." --as ${from}`, 5);
    emit({ agent: from, to, type: "msg", ticket: opts.ticket ? String(opts.ticket) : undefined, msg: words.join(" ") });
  },
  inbox() {
    const who = actor();
    const events = readEvents();
    // отметка прочитанного хранит, ДО какой строки лога прочитано: сообщение, пришедшее
    // между чтением и записью отметки, останется непрочитанным, а не потеряется
    const seen = opts.all ? 0 : events.filter((e) => e.type === "read" && e.agent === who).reduce((a, e) => Math.max(a, Number(e.upto) || 0), 0);
    const mine = events.map((e, i) => ({ e, i })).filter(({ e, i }) => i >= seen && e.type === "msg" && e.to === who);
    for (const { e } of mine) console.log(`${e.ts}  от ${e.agent}${e.ticket ? ` [${e.ticket}]` : ""}: ${e.msg}`);
    if (mine.length === 0) console.log("(новых сообщений нет)");
    if (!opts.all && mine.length) emit({ agent: who, type: "read", upto: mine[mine.length - 1].i + 1 });
  },
  events() {
    let ev = readEvents().filter((e) => e.type !== "read");
    if (opts.ticket) ev = ev.filter((e) => e.ticket && norm(e.ticket) === norm(opts.ticket));
    const n = Number(opts.tail) || ev.length;
    for (const e of ev.slice(-n)) console.log(`${e.ts}  ${e.agent}${e.to ? ` → ${e.to}` : ""}  ${e.type}${e.ticket ? ` [${e.ticket}]` : ""}  ${e.msg ?? ""}`);
  },
};

if (!cmd || cmd === "help" || opts.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
try {
  (commands[cmd] ?? (() => die(`неизвестная команда: ${cmd} (board help)`)))();
} catch (e) {
  if (!(e instanceof BoardError)) throw e;
  console.error(`[board] ${e.message}`);
  process.exit(e.exitCode);
}
