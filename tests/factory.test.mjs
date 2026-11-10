import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitRoot, sh, write } from "./helpers.mjs";

const factory = join(kitRoot, "tools", "factory.mjs");
const outsideGit = () => mkdtempSync(join(tmpdir(), "atk-factory-"));

// поддельный bb: spawn выдаёт новый тред, show отвечает по сохранённым тредам
function fakeBB() {
  const dir = mkdtempSync(join(tmpdir(), "fake-bb-"));
  const db = join(dir, "threads.json");
  writeFileSync(db, "{}");
  const cli = join(dir, "bb");
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require("fs"); const db = ${JSON.stringify(db)};
const a = process.argv.slice(2); const t = JSON.parse(fs.readFileSync(db, "utf8"));
const v = (k) => a[a.indexOf(k) + 1];
if (a[0] === "thread" && a[1] === "spawn") {
  const id = "thr_" + (Object.keys(t).length + 1);
  t[id] = { id, providerId: v("--provider"), title: v("--title"), environmentId: a.includes("--environment") ? v("--environment") : "env_" + id };
  fs.writeFileSync(db, JSON.stringify(t)); console.log(JSON.stringify(t[id]));
} else if (a[0] === "thread" && a[1] === "show") {
  if (!t[a[2]]) { console.error("нет треда"); process.exit(1); }
  console.log(JSON.stringify({ thread: t[a[2]], environment: { id: t[a[2]].environmentId } }));
} else if (a[0] === "thread" && a[1] === "log") {
  const th = t[a[2]]; if (!th) process.exit(1);
  console.log(JSON.stringify((th.report ? [th.report] : []).map((text) => ({ type: "item/completed", data: { item: { type: "agentMessage", text } } }))));
} else process.exit(9);
`);
  return { cli, add: (id, thread) => { const t = JSON.parse(readFileSync(db, "utf8")); t[id] = thread; writeFileSync(db, JSON.stringify(t)); } };
}

function factoryEnv(cwd = outsideGit()) {
  const bb = fakeBB();
  const env = { ...process.env, BB_PROJECT_ID: "proj_t", BB_THREAD_ID: "thr_lead", BB_CLI: bb.cli, AGENT_TOOLKIT_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")) };
  const run = (args, input = "сделай X") => sh(cwd, "node", [factory, ...args], { input, env });
  const spawn = (...args) => {
    const r = run(["spawn", ...args, "--task", "-"]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const dry = (...args) => JSON.parse(run(["spawn", ...args, "--task", "-", "--dry-run"]).stdout);
  return { run, spawn, dry, bb, cwd };
}
const arg = (bb, k) => bb[bb.indexOf(k) + 1];

test("роли — в коде, агенты — в конфиге: исполнитель берёт провайдера и модель агента, новый worktree", () => {
  const f = factoryEnv();
  const d = f.dry("executor", "--worker", "deepseek");
  assert.equal(arg(d.bb, "--provider"), "acp-opencode");
  assert.equal(arg(d.bb, "--model"), "opencode-go/deepseek-v4.1-flash");
  assert.equal(arg(d.bb, "--new-environment"), "worktree");
  assert.match(arg(d.bb, "--title"), /^executor\[deepseek\]: /);
  assert.ok(d.bb.includes("--parent-self"));
  assert.match(d.prompt, /Ты — исполнитель/);
  assert.match(d.prompt, /агент «deepseek»/);
  const s = f.dry("executor", "--worker", "sonnet");
  assert.equal(arg(s.bb, "--provider"), "claude-code");
  assert.equal(arg(s.bb, "--permission-mode"), "auto");
  assert.match(f.run(["spawn", "executor-sonnet", "--task", "-", "--dry-run"]).stderr, /роль executor-sonnet неизвестна/);
});

test("исполнения делятся поровну между агентами", () => {
  const f = factoryEnv();
  const picks = [1, 2, 3, 4].map(() => f.spawn("executor").worker);
  assert.deepEqual(picks, ["deepseek", "sonnet", "deepseek", "sonnet"]);
  assert.match(f.run(["workers"]).stdout, /deepseek .*исполнял: 2/);
});

test("перекрёстная проверка: проверяет другой агент на другой модели, в окружении исполнителя", () => {
  const f = factoryEnv();
  const ex = f.spawn("executor", "--worker", "deepseek");
  for (const role of ["verifier", "tester", "critic"]) {
    const v = f.dry(role, "--executor", ex.thread);
    assert.equal(v.worker, "sonnet", role);
    assert.equal(arg(v.bb, "--environment"), ex.environment, "окружение исполнителя");
    assert.ok(!v.bb.includes("--new-environment"));
    assert.match(v.prompt, /Работу делал агент «deepseek»/);
  }
  const ex2 = f.spawn("executor", "--worker", "sonnet");
  assert.equal(f.dry("verifier", "--executor", ex2.thread).worker, "deepseek");
  const self = f.run(["spawn", "verifier", "--executor", ex.thread, "--worker", "deepseek", "--task", "-", "--dry-run"]);
  assert.equal(self.status, 3, "сам себя не проверяет");
  assert.match(self.stderr, /другой агент на другой модели/);
});

test("универсально: только OpenAI — два агента на codex с разными моделями работают", () => {
  const repo = outsideGit();
  sh(repo, "git", ["init", "-q"]);
  write(repo, ".agents/factory.json", JSON.stringify({ workers: {
    deepseek: null, sonnet: null,
    big: { provider: "codex", model: "gpt-6", reasoning: "high" },
    fast: { provider: "codex", model: "gpt-6-mini", reasoning: "high" },
  } }));
  const f = factoryEnv(repo);
  const ex = f.spawn("executor");
  assert.equal(ex.worker, "big");
  const v = f.dry("verifier", "--executor", ex.thread);
  assert.equal(v.worker, "fast");
  assert.equal(arg(v.bb, "--provider"), "codex");
  assert.equal(arg(v.bb, "--model"), "gpt-6-mini");
});

test("один агент или все на одной модели — проверить некому, отказ с подсказкой", () => {
  const repo = outsideGit();
  sh(repo, "git", ["init", "-q"]);
  write(repo, ".agents/factory.json", JSON.stringify({ workers: { deepseek: null, sonnet: { model: "same" }, extra: { provider: "codex", model: "same" } } }));
  const f = factoryEnv(repo);
  const ex = f.spawn("executor", "--worker", "sonnet");
  const r = f.run(["spawn", "verifier", "--executor", ex.thread, "--task", "-", "--dry-run"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /проверить некому/);
  assert.match(f.run(["workers"]).stderr, /одной модели/);
});

test("тред, запущенный не через factory: метка в заголовке, иначе единственный агент провайдера, иначе отказ", () => {
  const f = factoryEnv();
  f.bb.add("thr_tag", { id: "thr_tag", providerId: "x", title: "executor[sonnet]: что-то", environmentId: "env_a" });
  assert.equal(f.dry("verifier", "--executor", "thr_tag").worker, "deepseek");
  f.bb.add("thr_prov", { id: "thr_prov", providerId: "acp-opencode", title: "руками", environmentId: "env_b" });
  assert.equal(f.dry("verifier", "--executor", "thr_prov").worker, "sonnet");
  f.bb.add("thr_unk", { id: "thr_unk", providerId: "codex", title: "руками", environmentId: "env_c" });
  assert.equal(f.run(["spawn", "verifier", "--executor", "thr_unk", "--task", "-", "--dry-run"]).status, 3);
});

test("понятные ошибки: без --executor, без задачи, без bb-контекста, неизвестный агент, старый формат конфига", () => {
  const f = factoryEnv();
  const no = f.run(["spawn", "verifier", "--task", "-", "--dry-run"]);
  assert.equal(no.status, 3);
  assert.match(no.stderr, /--executor/);
  assert.match(f.run(["spawn", "executor", "--dry-run"]).stderr, /--task/);
  assert.match(f.run(["spawn", "executor", "--worker", "nope", "--task", "-", "--dry-run"]).stderr, /агента «nope» нет/);
  const noCtx = sh(outsideGit(), "node", [factory, "spawn", "executor", "--task", "-", "--dry-run"], { input: "x", env: { ...process.env, BB_PROJECT_ID: "" } });
  assert.match(noCtx.stderr, /BB_PROJECT_ID/);
  const repo = outsideGit();
  sh(repo, "git", ["init", "-q"]);
  write(repo, ".agents/factory.json", JSON.stringify({ roles: { executor: { provider: "p", model: "m" } } }));
  assert.match(factoryEnv(repo).run(["workers"]).stderr, /старый формат/);
});

test("проверяющий получает дословный отчёт исполнителя из bb, а не пересказ оркестратора", () => {
  const f = factoryEnv();
  f.bb.add("thr_r", { id: "thr_r", providerId: "acp-opencode", title: "executor[deepseek]: x", environmentId: "env_r",
    report: "Сделал X. В package.json нет скрипта test, гейт запускать нечего." });
  const v = f.dry("verifier", "--executor", "thr_r");
  assert.match(v.prompt, /## Отчёт исполнителя — дословно/);
  assert.match(v.prompt, /В package\.json нет скрипта test/);
  assert.match(v.prompt, /включая побочные/);
  f.bb.add("thr_n", { id: "thr_n", providerId: "acp-opencode", title: "executor[deepseek]: y", environmentId: "env_n" });
  assert.match(f.dry("verifier", "--executor", "thr_n").prompt, /Отчёт не найден.*bb thread log thr_n/);
});
