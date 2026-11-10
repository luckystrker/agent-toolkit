import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitRoot, sh, write } from "./helpers.mjs";

const install = join(kitRoot, "install.mjs");

test("project-режим ставит скиллы, секцию, хуки и .agents/bin; --remove убирает, данные фабрики оставляет", () => {
  const home = mkdtempSync(join(tmpdir(), "atk-home-"));
  const proj = mkdtempSync(join(tmpdir(), "atk-proj-"));
  sh(proj, "git", ["init", "-q"]);
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  const r = sh(kitRoot, "node", [install, "--project", proj], { env });
  assert.equal(r.status, 0, r.stderr);

  const skills = readdirSync(join(kitRoot, "skills"));
  for (const s of skills) assert.ok(existsSync(join(proj, ".agents/skills", s, "SKILL.md")), `скилл ${s}`);
  assert.ok(existsSync(join(proj, ".agents/skills/judge/decisions-template.md")), "шаблоны едут вместе со скиллом");
  for (const t of ["board.mjs", "bench-compare.mjs"]) {
    const p = join(proj, ".agents/bin", t);
    assert.ok(existsSync(p), t);
    assert.ok(statSync(p).mode & 0o100, `${t} исполняемый`);
  }
  const agents = readFileSync(join(proj, "AGENTS.md"), "utf8");
  for (const s of skills) assert.match(agents, new RegExp(`\\| ${s} \\|`), `скилл ${s} в индексе AGENTS.md`);
  assert.equal(sh(proj, "git", ["config", "core.hooksPath"]).stdout.trim(), ".githooks");

  write(proj, "tasks/001-x.md", "---\nid: 001\n---\n");
  const rm = sh(kitRoot, "node", [install, "--remove", "--project", proj], { env });
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(!existsSync(join(proj, ".agents/bin/board.mjs")));
  assert.ok(!existsSync(join(proj, ".agents/skills/judge")));
  assert.ok(existsSync(join(proj, "tasks/001-x.md")), "данные проекта не трогаем");
  assert.doesNotMatch(readFileSync(join(proj, "AGENTS.md"), "utf8"), /agent-toolkit:pipeline/);
});

test("user-режим для Claude Code: скиллы, роль оркестратора, роли фабрики, инструменты, глобальный гейт; --remove убирает всё", () => {
  const home = mkdtempSync(join(tmpdir(), "atk-home-"));
  mkdirSync(join(home, ".claude"));
  write(home, ".claude/settings.json", JSON.stringify({ autoUpdatesChannel: "stable", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo чужой" }] }] } }));
  write(home, ".claude/CLAUDE.md", "# мои правила\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  const r = sh(kitRoot, "node", [install, "--claude-hook", "--profile", "--no-tla"], { env });
  assert.equal(r.status, 0, r.stderr);
  for (const s of readdirSync(join(kitRoot, "skills"))) assert.ok(existsSync(join(home, ".claude/skills", s, "SKILL.md")), s);
  const md = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  assert.match(md, /# мои правила/);
  assert.match(md, /agent-toolkit:pipeline:start/);
  assert.match(md, /agent-toolkit:orchestrator:start/);
  assert.match(md, /agent-toolkit:profile:start/);
  assert.match(md, /~\/\.agent-toolkit\/bin\//, "в секции указан глобальный каталог инструментов");
  assert.doesNotMatch(md, /\{\{[A-Z_]+\}\}/, "плейсхолдеры подставлены");
  for (const a of ["executor", "verifier", "tester", "critic"]) assert.ok(existsSync(join(home, ".agent-toolkit/roles", `${a}.md`)), a);
  assert.ok(!existsSync(join(home, ".claude/agents")), "своих субагентов Claude не ставим — исполнители это bb-треды");
  for (const t of ["bin/board.mjs", "bin/bench-compare.mjs", "bin/factory.mjs", "gate/pre-commit", "factory.json"]) assert.ok(existsSync(join(home, ".agent-toolkit", t)), t);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  assert.equal(settings.autoUpdatesChannel, "stable");
  assert.equal(settings.hooks.PreToolUse.length, 2, "чужой хук сохранён, наш добавлен");
  assert.match(JSON.stringify(settings), /\.agent-toolkit\/gate\/pre-commit/);

  const again = sh(kitRoot, "node", [install, "--claude-hook", "--profile", "--no-tla"], { env });
  assert.equal(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks.PreToolUse.length, 2, "повторная установка не дублирует хук");
  assert.equal(again.status, 0);

  const rm = sh(kitRoot, "node", [install, "--remove"], { env });
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(!existsSync(join(home, ".agent-toolkit/roles/executor.md")));
  assert.ok(!existsSync(join(home, ".agent-toolkit/factory.json")), "неизменённый factory.json убран");
  assert.ok(!existsSync(join(home, ".claude/skills/judge")));
  assert.ok(!existsSync(join(home, ".agent-toolkit/gate/pre-commit")));
  const after = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  assert.equal(after.hooks.PreToolUse.length, 1, "остался только чужой хук");
  const mdAfter = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  assert.match(mdAfter, /# мои правила/);
  assert.doesNotMatch(mdAfter, /agent-toolkit/);
});

test("factory.json владельца не перезаписывается и переживает --remove; старые субагенты Claude убираются", () => {
  const home = mkdtempSync(join(tmpdir(), "atk-home-"));
  mkdirSync(join(home, ".claude"));
  write(home, ".agent-toolkit/factory.json", '{"roles":{"executor":{"provider":"p","model":"мой"}}}');
  write(home, ".claude/agents/executor.md", "старый субагент");
  write(home, ".agent-toolkit/manifest.json", JSON.stringify({ version: "3.1.0", userSkillsDirs: [], userInstructionFiles: [], projects: [], userClaudeAgents: [join(home, ".claude/agents/executor.md")] }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  assert.equal(sh(kitRoot, "node", [install, "--no-tla"], { env }).status, 0);
  assert.match(readFileSync(join(home, ".agent-toolkit/factory.json"), "utf8"), /мой/);
  assert.ok(!existsSync(join(home, ".claude/agents/executor.md")), "миграция");
  assert.equal(sh(kitRoot, "node", [install, "--remove"], { env }).status, 0);
  assert.match(readFileSync(join(home, ".agent-toolkit/factory.json"), "utf8"), /мой/, "настройка владельца осталась");
});
