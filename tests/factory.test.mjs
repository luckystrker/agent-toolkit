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

test("verifier: другая модель (Muse Spark), окружение исполнителя обязательно", () => {
  const no = run(outsideGit(), ["spawn", "verifier", "--task", "-", "--dry-run"]);
  assert.equal(no.status, 3);
  assert.match(no.stderr, /--env/);
  const r = run(outsideGit(), ["spawn", "verifier", "--env", "env_1", "--task", "-", "--dry-run"]);
  const { bb } = JSON.parse(r.stdout);
  assert.equal(bb[bb.indexOf("--model") + 1], "opencode-go/muse-spark-1.3-contributor");
  assert.equal(bb[bb.indexOf("--environment") + 1], "env_1");
  assert.ok(!bb.includes("--new-environment"));
});

test("проект не может посадить проверяющего на модель исполнителя", () => {
  const repo = outsideGit();
  sh(repo, "git", ["init", "-q"]);
  write(repo, ".agents/factory.json", JSON.stringify({ roles: { verifier: { model: "opencode-go/deepseek-v4.1-flash" } } }));
  const r = run(repo, ["spawn", "verifier", "--env", "e", "--task", "-", "--dry-run"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /другая модель/);
  assert.equal(run(repo, ["roles"]).status, 3);
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
