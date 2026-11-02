import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
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
