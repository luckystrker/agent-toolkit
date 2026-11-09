#!/usr/bin/env node
// Установщик agent-toolkit. Node ≥ 18, без зависимостей.
//
// Режимы:
//   node install.mjs                          # user: скиллы + пайплайн-секция во все найденные harness'ы
//   node install.mjs --project <путь>         # project: скиллы в репо + секция AGENTS.md + git-гейт + .agents/bin (доска, бенч)
// Дополнительно:
//   --profile            # + профиль-секция в пользовательские файлы инструкций
//   --skills-dir <путь>  # явная цель для скиллов (Pi, Qoder, Antigravity, ...)
//   --zcode-hook         # (project) PreToolUse-адаптер ZCode (.zcode/config.json)
//   --claude-hook        # PreToolUse-гейт Claude Code: с --project — в .claude/settings.json проекта,
//                        # без — глобально в ~/.claude/settings.json (гейт на git commit в любом проекте)
//   --instructions <файл># доп. файл инструкций (CLAUDE.md, QODER.md, ...) — можно несколько
//   --dry-run            # показать план, ничего не менять
//   --remove             # убрать установленное (по манифесту); флаги те же
//   --version
//
// Ничего не перезаписывает молча: изменённые файлы копируются в
// ~/.agent-toolkit/backups/<дата>/ перед записью. Установленное регистрируется
// в ~/.agent-toolkit/manifest.json — его и откатывает --remove.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "3.1.0";
const kitRoot = fileURLToPath(new URL(".", import.meta.url));
const metaRoot = join(homedir(), ".agent-toolkit");
const manifestPath = join(metaRoot, "manifest.json");

// --- аргументы ---

const args = process.argv.slice(2);
const flags = new Map(); // имя → массив значений (флаг без значения → [""])
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith("--")) { console.error(`не понимаю аргумент: ${args[i]}`); process.exit(1); }
  const name = args[i].slice(2);
  const value = args[i + 1]?.startsWith("--") || args[i + 1] === undefined ? "" : args[++i];
  flags.set(name, [...(flags.get(name) ?? []), value]);
}
const has = (name) => flags.has(name);
const values = (name) => flags.get(name) ?? [];
const value = (name) => values(name).find((v) => v !== "");
const dryRun = has("dry-run");
const remove = has("remove");

if (has("version")) { console.log(VERSION); process.exit(0); }
if (has("help")) { console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 20).join("\n")); process.exit(0); }
for (const [name, minValues] of [["project", 1], ["skills-dir", 1], ["instructions", 1]]) {
  if (has(name) && values(name).filter((v) => v !== "").length < minValues) {
    console.error(`--${name} требует значение`);
    process.exit(1);
  }
}

// --- источники тулкита ---

const toolNames = readdirSync(join(kitRoot, "tools")).filter((n) => n.endsWith(".mjs"));
const skillNames = readdirSync(join(kitRoot, "skills")).filter((n) => existsSync(join(kitRoot, "skills", n, "SKILL.md")));
const pipelineTemplate = readFileSync(join(kitRoot, "agents", "pipeline-section.md"), "utf8").trim();
// project-режим кладёт скиллы в .agents/skills (нативно сканирует OpenCode;
// остальные harness'ы находят их по индексу в секции AGENTS.md)
const sectionFor = (dir, bin) => pipelineTemplate.replaceAll("{{SKILLS_DIR}}", dir).replaceAll("{{BIN_DIR}}", bin);
const pipelineSectionProject = sectionFor("`.agents/skills/` от корня репозитория", "`.agents/bin/` от корня репозитория");
const pipelineSectionUser = sectionFor(
  "родной каталог скиллов текущего harness'а (например `~/.claude/skills/`, `~/.zcode/skills/`)",
  "`.agents/bin/` проекта, если он есть, иначе `~/.agent-toolkit/bin/`"
);
// роль CTO-оркестратора — для главной сессии Claude Code; исполнители и проверяющие —
// bb-треды, которые запускает tools/factory.mjs по roles/*.md и factory.json
const orchestratorSection = readFileSync(join(kitRoot, "agents", "orchestrator-section.md"), "utf8").trim().replaceAll("{{KIT_DIR}}", kitRoot.replace(/[\\/]$/, ""));
const roleFiles = readdirSync(join(kitRoot, "roles")).filter((n) => n.endsWith(".md"));

// роли фабрики рядом с инструментами: <base>/roles/*.md + <base>/factory.json.
// factory.json — настройка владельца (модели): кладём, только если его нет; не перезаписываем
function installFactory(base) {
  for (const name of roleFiles) {
    const src = join(kitRoot, "roles", name);
    const dest = join(base, "roles", name);
    if (samePath(src, dest)) { note(`  = ${dest} (уже актуален)`); continue; }
    backupExisting(dest);
    act(`  + ${dest}`, () => { mkdirSync(join(base, "roles"), { recursive: true }); cpSync(src, dest); });
  }
  const cfg = join(base, "factory.json");
  if (existsSync(cfg)) note(`  = ${cfg} (есть — модели владельца не трогаю)`);
  else act(`  + ${cfg}`, () => { mkdirSync(base, { recursive: true }); cpSync(join(kitRoot, "factory.json"), cfg); });
}
function removeFactory(base) {
  for (const name of roleFiles) {
    const target = join(base, "roles", name);
    if (existsSync(target)) act(`  − ${target}`, () => rmSync(target, { force: true }));
  }
  const cfg = join(base, "factory.json");
  if (existsSync(cfg) && samePath(join(kitRoot, "factory.json"), cfg)) act(`  − ${cfg}`, () => rmSync(cfg, { force: true }));
  else if (existsSync(cfg)) note(`  = ${cfg} (изменён владельцем — оставлен)`);
}
// глобальный слой исполняемого: инструменты и гейт для любого репозитория
const userBinDir = join(metaRoot, "bin");
const userGatePath = join(metaRoot, "gate", "pre-commit");
const profileSection = [
  "<!-- agent-toolkit:profile:start -->",
  readFileSync(join(kitRoot, "profile", "AGENTS-user.md"), "utf8").trim(),
  "<!-- agent-toolkit:profile:end -->",
].join("\n");

// harness'ы с известными путями; детекция — существует ли домашний каталог.
// Pi, Qoder, Antigravity, Devin — через --skills-dir/--instructions или project-режим.
const HARNESS_DEFS = [
  { id: "claude", home: ".claude", skillsSub: "skills", instr: "CLAUDE.md" },
  { id: "zcode", home: ".zcode", skillsSub: "skills", instr: "AGENTS.md" },
  { id: "codex", home: ".codex", skillsSub: "skills", instr: "AGENTS.md" },
  { id: "opencode", home: join(".config", "opencode"), skillsSub: "skills", instr: "AGENTS.md" },
];
const detected = HARNESS_DEFS.filter((h) => existsSync(join(homedir(), h.home)));

// --- хранилище: действия, бэкапы, манифест ---

const actions = [];
function act(desc, fn) {
  actions.push(desc);
  if (!dryRun) fn();
}
function note(desc) { actions.push(desc); }

let backupRoot = null;
function backupExisting(absPath) {
  if (!existsSync(absPath) || dryRun) return;
  backupRoot ??= join(metaRoot, "backups", new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19));
  const rel = absPath.replace(/^([a-zA-Z]:)?[\\/]/, "").replace(/[\\/]/g, "__");
  const dest = join(backupRoot, rel);
  mkdirSync(backupRoot, { recursive: true });
  cpSync(absPath, dest, { recursive: true });
  console.log(`  бэкап: ${absPath} → ${dest}`);
}

function readManifest() {
  try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return { version: VERSION, userSkillsDirs: [], userInstructionFiles: [], projects: [] }; }
}
let manifest = readManifest();
function saveManifest() {
  if (dryRun) return;
  mkdirSync(metaRoot, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// --- файловые операции ---

function samePath(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const sa = statSync(a), sb = statSync(b);
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  return readdirSync(a).every((n) => samePath(join(a, n), join(b, n))) && readdirSync(a).length === readdirSync(b).length;
}

function installSkill(sourceDir, targetDir) {
  if (samePath(sourceDir, targetDir)) { note(`  = ${targetDir} (уже актуален)`); return; }
  backupExisting(targetDir);
  act(`  + ${targetDir}${existsSync(targetDir) ? " (обновлён)" : ""}`, () => {
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });
  });
}

function upsertSection(text, section) {
  const key = section.match(/<!-- agent-toolkit:([a-z]+):start -->/)[1];
  const start = `<!-- agent-toolkit:${key}:start -->`;
  const end = `<!-- agent-toolkit:${key}:end -->`;
  const re = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end}`);
  const updated = re.test(text) ? text.replace(re, section) : `${text.trimEnd()}\n\n${section}\n`;
  return updated === text ? null : updated;
}

function upsertSectionsInFile(file, sections) {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  let updated = existing;
  for (const s of sections) updated = upsertSection(updated, s) ?? updated;
  if (updated === existing) { note(`  = ${file} (секции уже актуальны)`); return; }
  backupExisting(file);
  act(`  + ${file} (секция${sections.length > 1 ? "и" : ""} agent-toolkit)`, () => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, updated); });
}

function stripSectionsInFile(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  // нормализуем только концы файла; пустые строки в чужом контенте не трогаем
  const stripped = text.replace(/<!-- agent-toolkit:[a-z]+:start -->[\s\S]*?<!-- agent-toolkit:[a-z]+:end -->\n?/g, "").trimEnd() + "\n";
  if (stripped === text) { note(`  = ${file} (секций нет)`); return; }
  backupExisting(file);
  act(`  − ${file} (секции agent-toolkit удалены)`, () => writeFileSync(file, stripped));
}

// --- user-режим: скиллы + инструкции найденных harness'ов ---

const skillsTargets = [
  ...detected.map((h) => join(homedir(), h.home, h.skillsSub)),
  ...values("skills-dir").map((p) => resolve(p)),
];
const instrTargets = [
  ...detected.map((h) => join(homedir(), h.home, h.instr)),
  ...values("instructions").map((p) => resolve(p)),
];

function copyExecutable(src, dest) {
  if (samePath(src, dest)) { note(`  = ${dest} (уже актуален)`); return; }
  backupExisting(dest);
  act(`  + ${dest}`, () => { mkdirSync(join(dest, ".."), { recursive: true }); cpSync(src, dest); chmodSync(dest, 0o755); });
}

const claudeGlobalHookEntry = () => ({
  matcher: "Bash",
  hooks: [{ type: "command", command: `node "${userGatePath}"`, timeout: 420 }],
});

function installUserMode() {
  const sections = [pipelineSectionUser, ...(has("profile") ? [profileSection] : [])];
  const claudeHome = join(homedir(), ".claude");
  const claudeDetected = detected.some((h) => h.id === "claude");
  if (skillsTargets.length === 0 && instrTargets.length === 0) {
    console.error("Не нашёл установленных harness'ов (claude/zcode/codex/opencode).\n" +
      "Варианты: --project <путь> (универсально, работает везде), --skills-dir <путь>, либо создай каталог harness'а и повтори.");
    process.exitCode = 1;
    return;
  }
  for (const dir of skillsTargets) {
    console.log(`Скиллы → ${dir}`);
    for (const name of skillNames) installSkill(join(kitRoot, "skills", name), join(dir, name));
    if (!dryRun) { manifest.userSkillsDirs = [...new Set([...manifest.userSkillsDirs, dir])]; }
  }
  if (instrTargets.length > 0 || skillsTargets.length > 0) {
    for (const file of instrTargets) {
      console.log(`Инструкции → ${file}`);
      const isClaude = claudeDetected && resolve(file) === resolve(join(claudeHome, "CLAUDE.md"));
      upsertSectionsInFile(file, isClaude ? [...sections, orchestratorSection] : sections);
      if (!dryRun) { manifest.userInstructionFiles = [...new Set([...manifest.userInstructionFiles, file])]; }
    }
  }
  // исполняемый слой: доска, бенч и гейт — общие для всех проектов
  if (skillsTargets.length > 0 || instrTargets.length > 0) {
    console.log(`Инструменты → ${userBinDir}/, гейт → ${userGatePath}`);
    for (const name of toolNames) copyExecutable(join(kitRoot, "tools", name), join(userBinDir, name));
    copyExecutable(join(kitRoot, "gate", "pre-commit"), userGatePath);
    if (!dryRun) manifest.userTools = true;
  }

  // роли фабрики (bb-треды) — рядом с глобальными инструментами
  if (skillsTargets.length > 0 || instrTargets.length > 0) {
    console.log(`Роли фабрики → ${metaRoot}/roles/ (${roleFiles.map((n) => n.replace(/\.md$/, "")).join(", ")}) + factory.json`);
    installFactory(metaRoot);
  }

  // миграция с 3.1-черновика: субагенты Claude заменены bb-тредами — убрать установленные
  for (const target of manifest.userClaudeAgents ?? []) {
    if (!existsSync(target)) continue;
    backupExisting(target);
    act(`  − ${target} (субагенты Claude заменены bb-тредами)`, () => rmSync(target, { force: true }));
  }
  if (!dryRun) delete manifest.userClaudeAgents;

  // Claude Code: (по флагу) глобальный гейт-хук
  if (claudeDetected) {
    if (has("claude-hook")) {
      const settings = join(claudeHome, "settings.json");
      console.log(`Глобальный гейт Claude Code → ${settings}`);
      upsertAdapterConfig(settings, (c) => {
        c.hooks ??= {};
        const arr = (c.hooks.PreToolUse ??= []);
        if (JSON.stringify(arr).includes(".agent-toolkit/gate/pre-commit")) return null;
        arr.push(claudeGlobalHookEntry());
        return c;
      });
      if (!dryRun) manifest.userClaudeHook = settings;
    }
  } else if (has("claude-hook")) {
    console.error("--claude-hook: Claude Code не найден (~/.claude отсутствует) — глобальный хук не ставлю.");
    process.exitCode = 1;
  }

  if (has("profile") && instrTargets.length === 0) {
    console.error("--profile: не найдено файлов пользовательских инструкций (см. список выше) — профиль не вставлен.");
    process.exitCode = 1;
  }
  if (instrTargets.length === 0 && skillsTargets.length > 0) {
    console.error(
      "Внимание: секция-диспетчер пайплайна не доставлена ни в один файл инструкций —\n" +
      "скиллы установлены, но правила конвейера в контекст агента не попали.\n" +
      "Добавь --instructions <файл> (например, AGENTS.md проекта) или используй --project."
    );
  }
}

function removeUserMode() {
  for (const dir of manifest.userSkillsDirs ?? []) {
    console.log(`Скиллы − ${dir}`);
    for (const name of skillNames) {
      const target = join(dir, name);
      if (!existsSync(target)) continue;
      backupExisting(target);
      act(`  − ${target}`, () => rmSync(target, { recursive: true, force: true }));
    }
  }
  for (const file of manifest.userInstructionFiles ?? []) stripSectionsInFile(file);
  for (const target of manifest.userClaudeAgents ?? []) {
    if (!existsSync(target)) continue;
    backupExisting(target);
    act(`  − ${target}`, () => rmSync(target, { force: true }));
  }
  if (manifest.userTools) {
    for (const target of [...toolNames.map((n) => join(userBinDir, n)), userGatePath]) {
      if (!existsSync(target)) continue;
      act(`  − ${target}`, () => rmSync(target, { force: true }));
    }
    removeFactory(metaRoot);
  }
  if (manifest.userClaudeHook && existsSync(manifest.userClaudeHook)) {
    const file = manifest.userClaudeHook;
    try {
      const config = JSON.parse(readFileSync(file, "utf8"));
      const arr = config.hooks?.PreToolUse;
      if (Array.isArray(arr)) {
        const filtered = arr.filter((g) => !JSON.stringify(g).includes(".agent-toolkit/gate/pre-commit"));
        if (filtered.length !== arr.length) {
          if (filtered.length) config.hooks.PreToolUse = filtered; else delete config.hooks.PreToolUse;
          if (Object.keys(config.hooks).length === 0) delete config.hooks;
          backupExisting(file);
          act(`  − ${file} (глобальный гейт удалён)`, () => writeFileSync(file, JSON.stringify(config, null, 2) + "\n"));
        }
      }
    } catch { console.error(`  ${file} не парсится — хук не удалён, убери запись вручную`); }
  }
  manifest.userSkillsDirs = [];
  manifest.userInstructionFiles = [];
  delete manifest.userClaudeAgents;
  delete manifest.userTools;
  delete manifest.userClaudeHook;
}

// --- project-режим ---

const projectDir = has("project") ? resolve(value("project")) : null;
// записи в манифесте: относительный путь внутри проекта либо абсолютный (вне проекта —
// сравнение через path.relative, не строковым префиксом: "alp" ≠ родитель "alp-extra")
const projectInstructions = ["AGENTS.md", ...values("instructions").map((p) => {
  const abs = resolve(p);
  const rel = relative(projectDir, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
})];
const instrFile = (entry) => (isAbsolute(entry) ? entry : join(projectDir, entry));

const HOOKS = {
  "pre-commit": null, // гейт качества; источник подставляется ниже
  "commit-msg": null, // ссылка на чек-лист в сообщении коммита
};

function gitIn(dir, cmdArgs) {
  return spawnSync("git", ["-C", dir, ...cmdArgs], { encoding: "utf8" });
}

function zcodeHookEntry() {
  return {
    matcher: "Bash",
    hooks: [{
      type: "process", command: "node",
      args: ["${ZCODE_PROJECT_DIR}/.githooks/pre-commit"],
      timeoutMs: 420000, statusMessage: "Прогоняю гейт качества перед коммитом…",
    }],
  };
}
const claudeHookEntry = () => ({
  matcher: "Bash",
  hooks: [{ type: "command", command: "node .githooks/pre-commit", timeout: 420 }],
});

function upsertAdapterConfig(file, wire) {
  // wire(configJson) возвращает изменённый объект или null, если уже стоит
  let config = {};
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, "utf8")); }
    catch { console.error(`  ${file} не парсится как JSON — не трогаю`); process.exitCode = 1; return; }
  }
  const updated = wire(config);
  if (!updated) { note(`  = ${file} (адаптер уже подключён)`); return; }
  backupExisting(file);
  act(`  + ${file} (адаптер гейта)`, () => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(updated, null, 2) + "\n"); });
}

function installProjectMode() {
  if (!existsSync(projectDir)) { console.error(`--project: ${projectDir} не существует`); process.exitCode = 1; return; }
  const isGit = existsSync(join(projectDir, ".git"));
  let previousHooksPath = null;

  // 1. скиллы в репозиторий: .agents/skills — нативно для OpenCode,
  //    для остальных — через индекс в секции AGENTS.md (шаг 2)
  for (const name of skillNames) {
    const from = join(kitRoot, "skills", name);
    const to = join(projectDir, ".agents", "skills", name);
    console.log(`Скилл ${name} → ${to}`);
    installSkill(from, to);
  }

  // 1b. исполняемый слой фабрики: общая доска + лог событий, сравнение бенчмарков
  const binDir = join(projectDir, ".agents", "bin");
  console.log(`Инструменты → ${binDir}/ (${toolNames.join(", ")})`);
  for (const name of toolNames) {
    const src = join(kitRoot, "tools", name);
    const dest = join(binDir, name);
    if (samePath(src, dest)) { note(`  = ${dest} (уже актуален)`); continue; }
    backupExisting(dest);
    act(`  + ${dest}`, () => { mkdirSync(binDir, { recursive: true }); cpSync(src, dest); chmodSync(dest, 0o755); });
  }

  installFactory(join(projectDir, ".agents"));

  // 2. секция-диспетчер в файлы инструкций
  const sections = [pipelineSectionProject];
  for (const rel of projectInstructions) {
    console.log(`Инструкции → ${instrFile(rel)}`);
    upsertSectionsInFile(instrFile(rel), sections);
  }

  // 3. git-хуки: pre-commit (гейт) + commit-msg (ссылка на чек-лист) —
  //    универсальное принуждение (терминал, IDE, любой агент, обёртки)
  if (!isGit) {
    console.error("Не git-репозиторий (.git не найден) — хуки не ставлю, остальное установлено.");
    process.exitCode = 1;
  } else {
    const hooksDir = join(projectDir, ".githooks");
    console.log(`Хуки → ${hooksDir}/ (pre-commit, commit-msg) + git config core.hooksPath .githooks`);
    for (const name of Object.keys(HOOKS)) {
      const src = join(kitRoot, "gate", name);
      const dest = join(hooksDir, name);
      if (samePath(src, dest)) { note(`  = ${dest} (уже актуален)`); continue; }
      backupExisting(dest);
      act(`  + ${dest}`, () => {
        mkdirSync(hooksDir, { recursive: true });
        cpSync(src, dest);
        chmodSync(dest, 0o755); // POSIX: без бита исполнения git молча пропускает хук
      });
    }
    previousHooksPath = gitIn(projectDir, ["config", "--get", "core.hooksPath"]).stdout.trim() || null;
    if (previousHooksPath && previousHooksPath !== ".githooks") {
      console.error(
        `  внимание: проект уже использует core.hooksPath=${previousHooksPath} (чужие хуки: husky/lefthook?).\n` +
        `  Установщик переключит его на .githooks; прежнее значение сохранено в манифесте и вернётся при --remove.`
      );
    }
    act(`  + git config core.hooksPath .githooks`, () => {
      const res = gitIn(projectDir, ["config", "core.hooksPath", ".githooks"]);
      if (res.status !== 0) { console.error(`git config не удался:\n${res.stderr}`); process.exitCode = 1; }
    });
  }

  // 4. опциональные PreToolUse-адаптеры (дублируют гейт ради UX статуса в harness)
  const adapters = [];
  if (has("zcode-hook")) {
    console.log("Адаптер ZCode → .zcode/config.json");
    upsertAdapterConfig(join(projectDir, ".zcode", "config.json"), (c) => {
      c.hooks ??= {}; c.hooks.enabled = true; c.hooks.events ??= {};
      const arr = (c.hooks.events.PreToolUse ??= []);
      if (JSON.stringify(arr).includes(".githooks/pre-commit")) return null;
      arr.push(zcodeHookEntry());
      return c;
    });
    adapters.push("zcode");
  }
  if (has("claude-hook")) {
    console.log("Адаптер Claude Code → .claude/settings.json");
    upsertAdapterConfig(join(projectDir, ".claude", "settings.json"), (c) => {
      c.hooks ??= {}; // схема Claude: hooks.PreToolUse напрямую, без events
      const arr = (c.hooks.PreToolUse ??= []);
      if (JSON.stringify(arr).includes(".githooks/pre-commit")) return null;
      arr.push(claudeHookEntry());
      return c;
    });
    adapters.push("claude");
  }

  if (!dryRun) {
    manifest.projects = [
      ...manifest.projects.filter((p) => p.dir !== projectDir),
      { dir: projectDir, instructions: projectInstructions, adapters, previousHooksPath },
    ];
  }
}

function removeProjectMode() {
  const entry = manifest.projects.find((p) => resolve(p.dir) === projectDir);
  if (!entry) { console.error(`--remove --project: ${projectDir} отсутствует в манифесте`); process.exitCode = 1; return; }
  for (const name of skillNames) {
    const target = join(projectDir, ".agents", "skills", name);
    if (!existsSync(target)) continue;
    backupExisting(target);
    act(`  − ${target}`, () => rmSync(target, { recursive: true, force: true }));
  }
  for (const rel of entry.instructions) stripSectionsInFile(instrFile(rel));
  for (const name of toolNames) {
    const target = join(projectDir, ".agents", "bin", name);
    if (!existsSync(target)) continue;
    backupExisting(target);
    act(`  − ${target}`, () => rmSync(target, { force: true }));
  }
  removeFactory(join(projectDir, ".agents"));
  // данные фабрики (tasks/, .agents/events.jsonl, lessons, decisions) — это работа проекта, не тулкита: не удаляем

  const hooksDir = join(projectDir, ".githooks");
  for (const name of Object.keys(HOOKS)) {
    const dest = join(hooksDir, name);
    if (!existsSync(dest)) continue;
    backupExisting(dest);
    act(`  − ${dest}`, () => rmSync(dest, { force: true }));
  }
  // hooksPath: восстановить прежнее значение из манифеста; если своих хуков не
  // было — снять; в .githooks остались чужие хуки — оставить как есть
  const restore = entry.previousHooksPath && entry.previousHooksPath !== ".githooks" ? entry.previousHooksPath : null;
  const remaining = existsSync(hooksDir) ? readdirSync(hooksDir).length : 0;
  if (restore) {
    act(`  − git config core.hooksPath → ${restore} (восстановлено)`, () => gitIn(projectDir, ["config", "core.hooksPath", restore]));
  } else if (remaining === 0) {
    act(`  − git config --unset core.hooksPath`, () => gitIn(projectDir, ["config", "--unset", "core.hooksPath"]));
  } else {
    note(`  = core.hooksPath оставлен: в .githooks остались другие хуки (${remaining})`);
  }

  for (const adapter of entry.adapters ?? []) {
    const file = adapter === "zcode" ? join(projectDir, ".zcode", "config.json") : join(projectDir, ".claude", "settings.json");
    if (!existsSync(file)) continue;
    try {
      const config = JSON.parse(readFileSync(file, "utf8"));
      const hooks = (config.hooks ??= {});
      const container = adapter === "zcode" ? ((hooks.events ??= {})) : hooks;
      let changed = false;
      if (Array.isArray(container.PreToolUse)) {
        const filtered = container.PreToolUse.filter((g) => !JSON.stringify(g).includes(".githooks/pre-commit"));
        changed = filtered.length !== container.PreToolUse.length;
        if (filtered.length === 0) delete container.PreToolUse;
        else container.PreToolUse = filtered;
      }
      // вычистить опустевшие структуры, созданные установщиком
      if (adapter === "zcode" && hooks.events && Object.keys(hooks.events).length === 0) delete hooks.events;
      if (config.hooks && Object.keys(config.hooks).length === 0) delete config.hooks;
      if (!changed) { note(`  = ${file} (нашей записи нет)`); continue; }
      backupExisting(file);
      act(`  − ${file} (адаптер удалён)`, () => writeFileSync(file, JSON.stringify(config, null, 2) + "\n"));
    } catch { console.error(`  ${file} не парсится — пропускаю`); }
  }
  manifest.projects = manifest.projects.filter((p) => p.dir !== projectDir);
}

// --- запуск ---

console.log(dryRun ? `agent-toolkit v${VERSION} — dry-run (ничего не меняется)\n` : `agent-toolkit v${VERSION}\n`);
if (projectDir) { remove ? removeProjectMode() : installProjectMode(); }
else { remove ? removeUserMode() : installUserMode(); }
saveManifest();
console.log(`\n${dryRun ? `План (${actions.length} действий) — запусти без --dry-run для применения.` : `Готово: ${actions.length} действий.`}` +
  (backupRoot ? `\nБэкапы изменённого: ${backupRoot}` : ""));
if (actions.length === 0 && !process.exitCode) console.log("Изменений не требуется — всё уже актуально.");
