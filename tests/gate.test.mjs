import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRepo, write, commit, gatePayload, sh, kitRoot } from "./helpers.mjs";

test("gate.json: красная произвольная команда блокирует коммит, зелёная пропускает", () => {
  const red = tempRepo({ gateConfig: { gates: [{ name: "lint", run: "exit 3" }] } });
  write(red, "a.txt", "1");
  const r = commit(red);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /гейт `lint` упал/);

  const green = tempRepo({ gateConfig: { gates: [{ name: "lint", run: "true" }] } });
  write(green, "a.txt", "1");
  assert.equal(commit(green).status, 0);
});

test("gate.json: fail-fast — после упавшего гейта следующие не запускаются", () => {
  const dir = tempRepo({ gateConfig: { gates: [{ name: "a", run: "exit 1" }, { name: "b", run: "touch ran-b" }] } });
  write(dir, "a.txt", "1");
  commit(dir);
  assert.equal(sh(dir, "test", ["-e", "ran-b"]).status, 1);
});

test("npm: complexity и tlc входят в стандартный набор гейтов", () => {
  const dir = tempRepo({ pkg: { scripts: { complexity: "exit 7" } } });
  write(dir, "a.txt", "1");
  const r = commit(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /гейт `complexity` упал/);
});

test("без конфигурации гейтов — проход с явным предупреждением", () => {
  const dir = tempRepo();
  write(dir, "a.txt", "1");
  const r = commit(dir);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /НЕПРОВЕРЕННЫМ/);
});

test("защищённые пути: без одобрения человека — блок, с одобрением — проход", () => {
  const dir = tempRepo({ gateConfig: { gates: [], protected: ["src/billing/**", "migrations/"] } });
  write(dir, "src/app.js", "1");
  assert.equal(commit(dir).status, 0, "незащищённый путь проходит");

  write(dir, "src/billing/charge.js", "1");
  const blocked = commit(dir);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /защищённые пути/);
  assert.match(blocked.stderr, /src\/billing\/charge\.js/);

  const ok = commit(dir, "x [no-checklist]", { AGENT_TOOLKIT_HUMAN_APPROVED: "1" });
  assert.equal(ok.status, 0);

  write(dir, "db/migrations/001.sql", "1");
  assert.notEqual(commit(dir).status, 0, "имя каталога без слэша-префикса совпадает на любой глубине");
});

test("адаптер: агент не обходит проверки", () => {
  const dir = tempRepo({ gateConfig: { gates: [] } });
  for (const cmd of [
    'git commit --no-verify -m "x"',
    'git commit -nm "x"',
    'git -c core.hooksPath=/dev/null commit -m "x"',
    'AGENT_TOOLKIT_HUMAN_APPROVED=1 git commit -m "x"',
  ]) {
    const r = gatePayload(dir, cmd);
    assert.equal(r.status, 2, `должно блокироваться: ${cmd}`);
  }
});

test("адаптер: «-n» и «--no-verify» внутри сообщения коммита — не обход", () => {
  const dir = tempRepo({ gateConfig: { gates: [] } });
  assert.equal(gatePayload(dir, 'git commit -m "добавил флаг -n и --no-verify в CLI"').status, 0);
  assert.equal(gatePayload(dir, "git commit --amend --no-edit").status, 0);
});

test("адаптер: не-коммит команды не гейтятся", () => {
  const dir = tempRepo({ gateConfig: { gates: [{ name: "x", run: "exit 1" }] } });
  assert.equal(gatePayload(dir, "git status").status, 0);
  assert.equal(gatePayload(dir, "git help commit").status, 0);
});

test("битый gate.json — блок, а не проход вслепую", () => {
  const dir = tempRepo();
  write(dir, ".agents/gate.json", "{oops");
  write(dir, "a.txt", "1");
  const r = commit(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /не парсится/);
});

test("ревью №3: переименование из защищённого пути и не-ASCII имена ловятся", () => {
  const dir = tempRepo({ gateConfig: { gates: [], protected: ["secure/**"] } });
  write(dir, "secure/a.txt", "1");
  write(dir, "secure/café.txt", "1");
  assert.equal(commit(dir, "x [no-checklist]", { AGENT_TOOLKIT_HUMAN_APPROVED: "1" }).status, 0);
  sh(dir, "git", ["mv", "secure/a.txt", "moved.txt"]);
  assert.match(commit(dir).stderr, /защищённые пути/, "переименование");
  sh(dir, "git", ["reset", "-q", "--hard"]);
  write(dir, "secure/café.txt", "2");
  assert.match(commit(dir).stderr, /защищённые пути/, "не-ASCII имя");
});

test("ревью №3: protected строкой вместо массива — блок, а не тишина", () => {
  const dir = tempRepo({ gateConfig: { protected: "secure/**" } });
  write(dir, "a.txt", "1");
  const r = commit(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /должен быть массивом/);
});

test("ревью №4: сокращения, чужой --help и склейка кавычками не обходят адаптер", () => {
  const dir = tempRepo({ gateConfig: { gates: [] } });
  for (const cmd of [
    "git commit --no-verif -m x",
    "git commit --no-veri -m x",
    "git commit --no-verify -m x && ls --help",
    "env AGENT_TOOLKIT_HUMAN_''APPROVED=1 git commit -m x",
    'git -c core."hooksPath"=/x commit -m x',
  ]) assert.equal(gatePayload(dir, cmd).status, 2, cmd);
});

test("ревью №6: лог событий и lock-файлы доски не считаются расхождением дерева", () => {
  const dir = tempRepo({ gateConfig: { gates: [{ name: "ok", run: "true" }] } });
  write(dir, ".agents/events.jsonl", "{}\n");
  write(dir, "tasks/.locks/1.lock", "1");
  write(dir, "a.txt", "1");
  sh(dir, "git", ["add", "a.txt"]);
  const r = sh(dir, "git", ["commit", "-q", "-m", "x [no-checklist]"]);
  assert.equal(r.status, 0, r.stderr);
});

test("неотслеживаемый файл при наличии гейтов — блок (тесты видят файл, коммит — нет)", () => {
  const dir = tempRepo({ gateConfig: { gates: [{ name: "ok", run: "true" }] } });
  write(dir, "new-module.js", "1");
  write(dir, "a.txt", "1");
  sh(dir, "git", ["add", "a.txt"]);
  const r = sh(dir, "git", ["commit", "-q", "-m", "x [no-checklist]"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /new-module\.js/);
});

// глобальный хук: файл гейта лежит вне репозитория (~/.agent-toolkit/gate/pre-commit),
// репозиторий определяется по cwd из payload Claude Code
function globalGate() {
  const dir = mkdtempSync(join(tmpdir(), "atk-global-"));
  mkdirSync(join(dir, "gate"));
  cpSync(join(kitRoot, "gate", "pre-commit"), join(dir, "gate", "pre-commit"));
  return (cwd, command) => sh(tmpdir(), "node", [join(dir, "gate", "pre-commit")], { input: JSON.stringify({ cwd, tool_input: { command } }) });
}
function plainRepo(gateConfig) {
  const dir = mkdtempSync(join(tmpdir(), "atk-plain-"));
  sh(dir, "git", ["init", "-q"]);
  if (gateConfig) write(dir, ".agents/gate.json", JSON.stringify(gateConfig));
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

test("глобальный гейт: гейтит репозиторий из cwd payload'а", () => {
  const gate = globalGate();
  const red = plainRepo({ gates: [{ name: "lint", run: "exit 1" }] });
  const r = gate(red, 'git commit -m "x"');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /гейт `lint` упал/);
  assert.equal(gate(plainRepo({ gates: [{ name: "ok", run: "true" }] }), 'git commit -m "x"').status, 0);
});

test("глобальный гейт: проект без настроек — коммит проходит с предупреждением, обход всё равно блокируется", () => {
  const gate = globalGate();
  const bare = plainRepo();
  write(bare, "untracked.txt", "1");
  const r = gate(bare, 'git commit -m "x"');
  assert.equal(r.status, 0, "без гейтов сверка дерева не нужна");
  assert.match(r.stderr, /НЕПРОВЕРЕННЫМ/);
  assert.equal(gate(bare, "git commit --no-verify -m x").status, 2);
});

test("глобальный гейт: вне git — пропуск; в проекте со своим git-хуком — гейт не дублируется", () => {
  const gate = globalGate();
  assert.equal(gate(mkdtempSync(join(tmpdir(), "atk-nogit-")), "git commit -m x").status, 0);
  const own = tempRepo({ gateConfig: { gates: [{ name: "slow", run: "touch ran-twice" }] } });
  assert.equal(gate(own, "git commit -m x").status, 0);
  assert.equal(sh(own, "test", ["-e", "ran-twice"]).status, 1, "гейт прогонит git-хук проекта");
  assert.equal(gate(own, "git commit -n -m x").status, 2, "обход проверяется и здесь");
});

test("глобальный гейт: репозиторий из `cd X && git commit` и `git -C X commit`, а не из cwd сессии", () => {
  const gate = globalGate();
  const session = plainRepo();
  const red = plainRepo({ gates: [{ name: "lint", run: "exit 1" }] });
  assert.equal(gate(session, `cd ${red} && git commit -m x`).status, 2);
  assert.equal(gate(session, `cd '${red}' && git add -A && git commit -m x`).status, 2);
  assert.equal(gate(session, `git -C ${red} commit -m x`).status, 2);
  assert.equal(gate(session, "git commit -m x").status, 0, "без cd — репозиторий сессии");
});

test("адаптер: «git commit» внутри heredoc и строки — не коммит (ложное срабатывание вживую)", () => {
  const dir = tempRepo({ gateConfig: { gates: [{ name: "x", run: "exit 1" }] } });
  write(dir, "dirty.txt", "1"); // дерево расходится: настоящий коммит был бы заблокирован
  const heredoc = "cat >> README.md <<'EOF'\nЗапусти git commit --no-verify -m x\nEOF";
  assert.equal(gatePayload(dir, heredoc).status, 0, heredoc);
  assert.equal(gatePayload(dir, "python3 - <<'PY'\nprint('git commit')\nPY").status, 0);
  assert.equal(gatePayload(dir, 'echo "не делай git commit -n"').status, 0);
  assert.equal(gatePayload(dir, "cat > a <<EOF\ntext\nEOF\ngit commit -m x").status, 2, "коммит после heredoc ловится");
});
