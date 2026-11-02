import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitRoot, sh, write } from "./helpers.mjs";

const board = join(kitRoot, "tools", "board.mjs");
const ticket = (id, extra = "") => `---\nid: ${id}\ntitle: t${id}\nstatus: open\npriority: 2\n${extra}---\nТело тикета ${id}\n`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "atk-board-"));
  write(dir, "tasks/001-a.md", ticket("001"));
  write(dir, "tasks/002-b.md", ticket("002", "depends_on: [001]\n"));
  write(dir, "tasks/003-c.md", ticket("003", "human: required\n"));
  const run = (...args) => sh(dir, "node", [board, ...args], { env: { ...process.env, BOARD_ROOT: dir, AGENT_NAME: "" } });
  return { dir, run };
}

test("claim требует отправителя и атомарно назначает владельца", () => {
  const { dir, run } = setup();
  assert.equal(run("claim", "1").status, 1, "без --as нельзя");
  assert.equal(run("claim", "1", "--as", "exec-a").status, 0);
  assert.match(readFileSync(join(dir, "tasks/001-a.md"), "utf8"), /owner: exec-a/);
  assert.equal(run("claim", "1", "--as", "exec-b").status, 3, "второй не возьмёт занятый");
  assert.match(readFileSync(join(dir, "tasks/001-a.md"), "utf8"), /Тело тикета 001/, "тело сохраняется");
});

test("водопад: тикет с незакрытой зависимостью не берётся, next его пропускает", () => {
  const { run } = setup();
  assert.equal(run("claim", "2", "--as", "x").status, 3);
  assert.match(run("next").stdout, /^001/);
});

test("приёмку делает не исполнитель", () => {
  const { run } = setup();
  run("claim", "1", "--as", "exec-a");
  assert.equal(run("status", "1", "review", "--as", "exec-a").status, 0);
  assert.equal(run("status", "1", "done", "--as", "exec-a").status, 3, "сам себя не принимает");
  assert.equal(run("status", "1", "done", "--as", "verifier").status, 0);
  assert.equal(run("claim", "2", "--as", "exec-b").status, 0, "после done зависимость снята");
});

test("одинаковые модели исполнителя и проверки — done запрещён", () => {
  const { dir, run } = setup();
  write(dir, "tasks/004-d.md", ticket("004", "executor_model: sonnet\nverifier_model: sonnet\n"));
  run("claim", "4", "--as", "exec");
  run("status", "4", "review", "--as", "exec");
  const r = run("status", "4", "done", "--as", "verifier");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /другая модель/);
});

test("human: required: ни teamlead, ни агент с --as human без терминала не закрывают", () => {
  const { run } = setup();
  run("claim", "3", "--as", "exec");
  run("status", "3", "review", "--as", "exec");
  assert.equal(run("status", "3", "done", "--as", "teamlead").status, 3);
  const r = run("status", "3", "done", "--as", "human");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /интерактивном терминале/);
});

test("ревью №1: исполнитель не перепрыгивает review (claimed → done запрещён)", () => {
  const { run } = setup();
  run("claim", "1", "--as", "bob");
  const r = run("status", "1", "done", "--as", "bob");
  assert.equal(r.status, 3);
  assert.equal(run("status", "1", "done", "--as", "teamlead").status, 3, "и тимлид тоже — только через review");
});

test("ревью №2: роль teamlead не отменяет правило разных моделей", () => {
  const { dir, run } = setup();
  write(dir, "tasks/004-d.md", ticket("004", "executor_model: sonnet\nverifier_model: sonnet\n"));
  run("claim", "4", "--as", "exec");
  run("status", "4", "review", "--as", "exec");
  assert.equal(run("status", "4", "done", "--as", "teamlead").status, 3);
});

test("ревью №5: block-YAML — понятная ошибка, а не потеря зависимости; CRLF и комментарии сохраняются", () => {
  const { dir, run } = setup();
  write(dir, "tasks/005-e.md", "---\nid: 005\nstatus: open\ndepends_on:\n  - 2\n---\nтело\n");
  const r = run("claim", "5", "--as", "a");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /не разобрал строку frontmatter/);
  assert.match(readFileSync(join(dir, "tasks/005-e.md"), "utf8"), /  - 2/, "файл не тронут");

  write(dir, "tasks/006-f.md", "---\r\nid: 006\r\n# важный комментарий\r\nstatus: open\r\n---\r\nтело\r\n");
  assert.equal(run("claim", "6", "--as", "a").status, 0, "CRLF-тикет виден");
  const after = readFileSync(join(dir, "tasks/006-f.md"), "utf8");
  assert.match(after, /# важный комментарий/);
  assert.match(after, /status: claimed\r\n/);
});

test("ревью №7: lock упавшего агента снимается; сообщение после чтения не теряется", () => {
  const { dir, run } = setup();
  write(dir, "tasks/.locks/1.lock", "999999 2020-01-01");
  assert.equal(run("claim", "1", "--as", "a").status, 0, "мёртвый pid — lock снят");

  run("msg", "b", "раз", "--as", "a");
  assert.match(run("inbox", "--as", "b").stdout, /раз/);
  run("msg", "b", "два", "--as", "a");
  const second = run("inbox", "--as", "b").stdout;
  assert.match(second, /два/);
  assert.doesNotMatch(second, /раз/);
});

test("ревью №9: текст с «--» после разделителя; неизвестный флаг — ошибка", () => {
  const { run } = setup();
  assert.equal(run("log", "--as", "a", "--", "--force не нужен").status, 0);
  assert.match(run("events").stdout, /--force не нужен/);
  assert.equal(run("log", "x", "--as", "a", "--forse").status, 1);
});

test("рантайм доски сам себя исключает из git", () => {
  const { dir, run } = setup();
  run("claim", "1", "--as", "a");
  assert.match(readFileSync(join(dir, ".agents/.gitignore"), "utf8"), /events\.jsonl/);
  assert.equal(readFileSync(join(dir, "tasks/.locks/.gitignore"), "utf8"), "*\n");
});

test("лимит пинг-понга эскалирует, смена статуса сбрасывает счётчик", () => {
  const { run } = setup();
  for (let i = 0; i < 6; i++) assert.equal(run("msg", i % 2 ? "a" : "b", `m${i}`, "--as", i % 2 ? "b" : "a").status, 0);
  const r = run("msg", "b", "ещё", "--as", "a");
  assert.equal(r.status, 5);
  assert.match(r.stderr, /teamlead/);
  assert.equal(run("msg", "teamlead", "помоги", "--as", "a").status, 0, "к тимлиду можно всегда");
  run("claim", "1", "--as", "a");
  assert.equal(run("msg", "b", "продолжим", "--as", "a").status, 0);
});

test("inbox показывает только новое; каждое действие в общем логе с отправителем", () => {
  const { run } = setup();
  run("msg", "b", "привет", "--as", "a");
  assert.match(run("inbox", "--as", "b").stdout, /от a: привет/);
  assert.match(run("inbox", "--as", "b").stdout, /новых сообщений нет/);
  run("log", "начал", "--as", "a", "--ticket", "1");
  const ev = run("events").stdout;
  assert.match(ev, /a → b\s+msg/);
  assert.match(ev, /a\s+log \[1\]\s+начал/);
});
