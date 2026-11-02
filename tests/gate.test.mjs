import { test } from "node:test";
import assert from "node:assert/strict";
import { tempRepo, write, commit, gatePayload, sh } from "./helpers.mjs";

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
  const dir = tempRepo({ gateConfig: { gates: [] } });
  write(dir, ".agents/events.jsonl", "{}\n");
  write(dir, "tasks/.locks/1.lock", "1");
  write(dir, "a.txt", "1");
  sh(dir, "git", ["add", "a.txt"]);
  const r = sh(dir, "git", ["commit", "-q", "-m", "x [no-checklist]"]);
  assert.equal(r.status, 0, r.stderr);
});
