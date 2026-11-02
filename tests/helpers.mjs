import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const kitRoot = fileURLToPath(new URL("..", import.meta.url));

export function sh(cwd, cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", ...opts });
}

/** Временный git-репо с установленными хуками тулкита (как после install --project). */
export function tempRepo({ pkg, gateConfig } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atk-"));
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "t@t"]);
  sh(dir, "git", ["config", "user.name", "t"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(dir, ".githooks"));
  for (const h of ["pre-commit", "commit-msg"]) {
    cpSync(join(kitRoot, "gate", h), join(dir, ".githooks", h));
    chmodSync(join(dir, ".githooks", h), 0o755);
  }
  sh(dir, "git", ["config", "core.hooksPath", ".githooks"]);
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  if (gateConfig) {
    mkdirSync(join(dir, ".agents"), { recursive: true });
    writeFileSync(join(dir, ".agents", "gate.json"), JSON.stringify(gateConfig));
  }
  // базовый коммит в обход хуков: дальше тесты работают с чистым деревом
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "--no-verify", "--allow-empty", "-m", "init"]);
  return dir;
}

export function write(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

export function commit(dir, msg = "x [no-checklist]", env = {}) {
  sh(dir, "git", ["add", "-A"]);
  return sh(dir, "git", ["commit", "-q", "-m", msg], { env: { ...process.env, ...env } });
}

/** Прогон гейта в режиме PreToolUse-адаптера: payload в stdin. */
export function gatePayload(dir, command) {
  return sh(dir, "node", [join(dir, ".githooks", "pre-commit")], { input: JSON.stringify({ tool_input: { command } }) });
}
