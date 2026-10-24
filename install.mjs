#!/usr/bin/env node
// Установщик agent-toolkit: скиллы → ~/.zcode/skills/, хук → в проект,
// профиль → ~/.zcode/AGENTS.md. Node ≥ 18, без зависимостей.
//
// Использование:
//   node install.mjs                          # только скиллы
//   node install.mjs --project <путь>         # + хук качества в проект
//   node install.mjs --profile                # + профиль пользователя

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const projectDir = flagValue("--project");
const withProfile = args.includes("--profile");

const kitRoot = import.meta.dirname;
const zcodeSkills = join(homedir(), ".zcode", "skills");

// --- 1. Скиллы ---
mkdirSync(zcodeSkills, { recursive: true });
for (const entry of ["grilling", "spec-to-checklist", "acceptance", "handoff", "tdd", "code-review", "research"]) {
  const from = join(kitRoot, "skills", entry);
  if (!existsSync(from)) {
    console.error(`нет исходника: ${from}`);
    process.exitCode = 1;
    continue;
  }
  cpSync(from, join(zcodeSkills, entry), { recursive: true });
  console.log(`скилл ${entry} → ~/.zcode/skills/${entry}`);
}

// --- 2. Хук качества в проект ---
if (projectDir) {
  const target = resolve(projectDir);
  if (!existsSync(join(target, ".git"))) {
    console.error(`--project: ${target} не выглядит git-репозиторием (нет .git) — хук не ставлю`);
    process.exitCode = 1;
  } else {
    mkdirSync(join(target, ".zcode", "hooks"), { recursive: true });
    cpSync(join(kitRoot, "hooks", "pre-commit-gate.mjs"), join(target, ".zcode", "hooks", "pre-commit-gate.mjs"));

    const configPath = join(target, ".zcode", "config.json");
    let config = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        console.error(`${configPath} не парсится как JSON — конфиг не трогаю, хук уже скопирован`);
        process.exitCode = 1;
      }
    }
    if (!config.hooks?.events?.PreToolUse) {
      config.hooks = {
        ...(config.hooks ?? {}),
        enabled: true,
        events: {
          ...(config.hooks?.events ?? {}),
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "process",
                  command: "node",
                  args: ["${ZCODE_PROJECT_DIR}/.zcode/hooks/pre-commit-gate.mjs"],
                  timeoutMs: 180000,
                  statusMessage: "Прогоняю гейт качества перед коммитом…",
                },
              ],
            },
          ],
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`хук → ${target}/.zcode/ (config.json дополнен)`);
    } else {
      console.log(`хук → ${target}/.zcode/hooks/ (PreToolUse уже задан — config.json не трогал)`);
    }
  }
}

// --- 3. Профиль пользователя ---
if (withProfile) {
  const dest = join(homedir(), ".zcode", "AGENTS.md");
  if (existsSync(dest)) {
    const backup = `${dest}.bak`;
    cpSync(dest, backup);
    console.log(`существующий профиль сохранён: ${backup}`);
  }
  cpSync(join(kitRoot, "profile", "AGENTS-user.md"), dest);
  console.log(`профиль → ${dest}`);
}

console.log("готово");
