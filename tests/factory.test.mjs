import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitRoot, sh, write } from "./helpers.mjs";

const factory = join(kitRoot, "tools", "factory.mjs");
const env = { ...process.env, BB_PROJECT_ID: "proj_t", BB_THREAD_ID: "thr_parent" };
const run = (cwd, args, input = "сделай X") => sh(cwd, "node", [factory, ...args], { input, env });
const outsideGit = () => mkdtempSync(join(tmpdir(), "atk-factory-"));

test("executor: OpenCode DeepSeek, новый worktree, дочерний тред, задача и роль в промпте", () => {
  const r = run(outsideGit(), ["spawn", "executor", "--task", "-", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const { bb, prompt } = JSON.parse(r.stdout);
  const arg = (k) => bb[bb.indexOf(k) + 1];
  assert.equal(arg("--provider"), "acp-opencode");
  assert.equal(arg("--model"), "opencode-go/deepseek-v4.1-flash");
  assert.equal(arg("--reasoning-level"), "high");
  assert.equal(arg("--new-environment"), "worktree");
  assert.equal(arg("--project"), "proj_t");
  assert.ok(bb.includes("--parent-self"));
  assert.match(prompt, /Ты — исполнитель/);
  assert.match(prompt, /сделай X/);
  assert.match(prompt, /Не коммить/);
});

// фальшивый bb: `thread show <id> --json` отдаёт тред с провайдером из имени id (thr_<provider>)
function fakeBB() {
  const dir = outsideGit();
  const cli = join(dir, "bb.mjs");
  write(dir, "bb.mjs", `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "thread" && a[1] === "show") {
  const id = a[2];
  if (id === "thr_missing") { console.error("not found"); process.exit(4); }
  console.log(JSON.stringify({ thread: { id, providerId: id.slice(4), environmentId: "env_" + id.slice(4) } }));
} else process.exit(9);
`);
  return cli;
}
const runX = (cwd, args) => sh(cwd, "node", [factory, ...args], { input: "проверь X", env: { ...env, BB_CLI: fakeBB() } });

test("executor-sonnet: Claude Code, Sonnet 5.5, high, auto, новый worktree", () => {
  const r = run(outsideGit(), ["spawn", "executor-sonnet", "--task", "-", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const { bb, prompt } = JSON.parse(r.stdout);
  const arg = (k) => bb[bb.indexOf(k) + 1];
  assert.equal(arg("--provider"), "claude-code");
  assert.equal(arg("--model"), "claude-sonnet-5-5");
  assert.equal(arg("--reasoning-level"), "high");
  assert.equal(arg("--permission-mode"), "auto");
  assert.equal(arg("--new-environment"), "worktree");
  assert.match(prompt, /Ты — исполнитель/);
});

test("перекрёстная проверка: работу DeepSeek (OpenCode) проверяет Sonnet, работу Sonnet — DeepSeek", () => {
  for (const role of ["verifier", "tester", "critic"]) {
    const a = runX(outsideGit(), ["spawn", role, "--executor", "thr_acp-opencode", "--task", "-", "--dry-run"]);
    assert.equal(a.status, 0, a.stderr);
    const A = JSON.parse(a.stdout);
    const argA = (k) => A.bb[A.bb.indexOf(k) + 1];
    assert.equal(argA("--provider"), "claude-code", role);
    assert.equal(argA("--model"), "claude-sonnet-5-5", role);
    assert.equal(argA("--permission-mode"), "auto", role);
    assert.equal(argA("--environment"), "env_acp-opencode", "окружение — исполнителя");
    assert.ok(!A.bb.includes("--new-environment"));
    assert.match(A.prompt, /thr_acp-opencode/);

    const b = runX(outsideGit(), ["spawn", role, "--executor", "thr_claude-code", "--task", "-", "--dry-run"]);
    assert.equal(b.status, 0, b.stderr);
    const B = JSON.parse(b.stdout);
    const argB = (k) => B.bb[B.bb.indexOf(k) + 1];
    assert.equal(argB("--provider"), "acp-opencode", role);
    assert.equal(argB("--model"), "opencode-go/deepseek-v4.1-flash", role);
    assert.equal(argB("--environment"), "env_claude-code");
  }
});

test("перекрёстная проверка: без --executor, чужой провайдер, несовпадающий --env — отказ (3)", () => {
  const no = run(outsideGit(), ["spawn", "verifier", "--env", "env_1", "--task", "-", "--dry-run"]);
  assert.equal(no.status, 3);
  assert.match(no.stderr, /--executor/);
  const unknown = runX(outsideGit(), ["spawn", "verifier", "--executor", "thr_codex", "--task", "-", "--dry-run"]);
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /нет crossReview/);
  const mismatch = runX(outsideGit(), ["spawn", "verifier", "--executor", "thr_claude-code", "--env", "env_other", "--task", "-", "--dry-run"]);
  assert.equal(mismatch.status, 3);
  assert.match(mismatch.stderr, /не совпадает/);
  const missing = runX(outsideGit(), ["spawn", "verifier", "--executor", "thr_missing", "--task", "-", "--dry-run"]);
  assert.equal(missing.status, 1);
});

test("проект не может посадить проверяющего на провайдера/модель исполнителя", () => {
  const repo = outsideGit();
  sh(repo, "git", ["init", "-q"]);
  write(repo, ".agents/factory.json", JSON.stringify({ roles: { verifier: { crossReview: { "acp-opencode": { provider: "acp-opencode", model: "opencode-go/other" } } } } }));
  assert.equal(run(repo, ["roles"]).status, 3);
  const r = runX(repo, ["spawn", "verifier", "--executor", "thr_acp-opencode", "--task", "-", "--dry-run"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /другая модель/);

  const legacy = outsideGit();
  sh(legacy, "git", ["init", "-q"]);
  write(legacy, ".agents/factory.json", JSON.stringify({ roles: { verifier: { crossReview: null, provider: "claude-code", model: "claude-sonnet-5-5" } } }));
  const l = run(legacy, ["spawn", "verifier", "--env", "e", "--task", "-", "--dry-run"]);
  assert.equal(l.status, 3, "фиксированный проверяющий на модели executor-sonnet");
  assert.match(l.stderr, /другая модель/);
});

test("без crossReview — старый режим: фиксированная модель, --env обязателен", () => {
  const repo = outsideGit();
  sh(repo, "git", ["init", "-q"]);
  write(repo, ".agents/factory.json", JSON.stringify({ roles: { verifier: { crossReview: null, provider: "acp-opencode", model: "opencode-go/glm-5.3" } } }));
  const no = run(repo, ["spawn", "verifier", "--task", "-", "--dry-run"]);
  assert.equal(no.status, 3);
  assert.match(no.stderr, /--env/);
  const { bb } = JSON.parse(run(repo, ["spawn", "verifier", "--env", "env_1", "--task", "-", "--dry-run"]).stdout);
  assert.equal(bb[bb.indexOf("--model") + 1], "opencode-go/glm-5.3");
  assert.equal(bb[bb.indexOf("--environment") + 1], "env_1");
});

test("проектный factory.json перекрывает только указанные поля", () => {
  const repo = outsideGit();
  sh(repo, "git", ["init", "-q"]);
  write(repo, ".agents/factory.json", JSON.stringify({ roles: { executor: { model: "opencode-go/glm-5.3" } } }));
  const { bb } = JSON.parse(run(repo, ["spawn", "executor", "--task", "-", "--dry-run"]).stdout);
  assert.equal(bb[bb.indexOf("--model") + 1], "opencode-go/glm-5.3");
  assert.equal(bb[bb.indexOf("--provider") + 1], "acp-opencode", "провайдер унаследован");
});

test("без bb-контекста, без задачи, неизвестная роль — понятные ошибки", () => {
  const noCtx = sh(outsideGit(), "node", [factory, "spawn", "executor", "--task", "-", "--dry-run"], { input: "x", env: { ...process.env, BB_PROJECT_ID: "" } });
  assert.equal(noCtx.status, 1);
  assert.match(noCtx.stderr, /BB_PROJECT_ID/);
  assert.match(run(outsideGit(), ["spawn", "executor", "--dry-run"]).stderr, /--task/);
  assert.match(run(outsideGit(), ["spawn", "boss", "--task", "-", "--dry-run"]).stderr, /не описана/);
});
