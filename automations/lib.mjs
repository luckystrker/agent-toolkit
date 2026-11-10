// Общее для скриптов-автоматизаций agent-toolkit: вызов bb, состояние, запуск треда-оркестратора.
// Скрипт сам по себе ничего не чинит и не решает: он детерминированно замечает проблему и
// передаёт её агенту. Пусто на выходе = «всё в порядке», bb записывает тихий тик.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const stateDir = process.env.AGENT_TOOLKIT_STATE_DIR || join(homedir(), ".agent-toolkit", "state");

// голый `bb` может молчать (у $BB_CLI нет бита исполнения) — node-скрипт запускаем через node
export function bb(args) {
  const cli = process.env.BB_CLI;
  let exe = "bb";
  let pre = [];
  if (cli && existsSync(cli)) {
    const head = readFileSync(cli, "utf8").slice(0, 64);
    if (head.startsWith("#!") && head.includes("node")) { exe = process.execPath; pre = [cli]; } else exe = cli;
  }
  return spawnSync(exe, [...pre, ...args], { encoding: "utf8" });
}
export function bbJson(args) {
  const r = bb([...args, "--json"]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export function readState(name, fallback) {
  const p = join(stateDir, name);
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
export function writeState(name, value) {
  const p = join(stateDir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}
export const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// тред-оркестратор (главная роль) с отчётом скрипта; модель — из env автоматизации
export function spawnOrchestrator({ title, prompt }) {
  const project = process.env.BB_PROJECT_ID;
  if (!project) return { ok: false, error: "нет BB_PROJECT_ID" };
  const file = join(mkdtempSync(join(tmpdir(), "atk-auto-")), "prompt.md");
  writeFileSync(file, prompt);
  const args = ["thread", "spawn", "--project", project, "--title", title, "--prompt-file", file, "--new-environment", "worktree", "--json"];
  if (process.env.ORCHESTRATOR_PROVIDER) args.push("--provider", process.env.ORCHESTRATOR_PROVIDER);
  if (process.env.ORCHESTRATOR_MODEL) args.push("--model", process.env.ORCHESTRATOR_MODEL);
  if (process.env.ORCHESTRATOR_REASONING) args.push("--reasoning-level", process.env.ORCHESTRATOR_REASONING);
  const r = bb(args);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  try { return { ok: true, thread: JSON.parse(r.stdout).id }; } catch { return { ok: true, thread: r.stdout.trim() }; }
}
