// Пример TLA+ из скилла formal-verification обязан: (1) проходить TLC, (2) краснеть на мутанте
// из того же скилла. Нужны java и tla2tools.jar (TLA2TOOLS или ~/.agent-toolkit/tla/); иначе тест пропускается.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitRoot, sh } from "./helpers.mjs";

const jar = [process.env.TLA2TOOLS, join(homedir(), ".agent-toolkit/tla/tla2tools.jar")].find((p) => p && existsSync(p));
const java = process.env.JAVA || "java";
const hasJava = sh(kitRoot, java, ["-version"]).status === 0;
const skip = !jar || !existsSync(jar) || !hasJava ? "нужны java и TLA2TOOLS=<tla2tools.jar>" : false;

test("пример TLA+ из скилла: оригинал зелёный, мутант нарушает инвариант", { skip }, () => {
  const skill = readFileSync(join(kitRoot, "skills/formal-verification/SKILL.md"), "utf8");
  const tla = skill.match(/```tla\n([\s\S]*?)```/)[1];
  const cfg = skill.match(/```\n\\\* Transfer\.cfg\n([\s\S]*?)```/)[1];
  const dir = mkdtempSync(join(tmpdir(), "atk-tla-"));
  const guard = "b' = b + 1 /\\ inflight' = 0";
  assert.ok(tla.includes(guard), "мутируемая строка есть в примере");
  writeFileSync(join(dir, "Transfer.tla"), tla);
  writeFileSync(join(dir, "Transfer.cfg"), cfg);
  writeFileSync(join(dir, "Mutant.tla"), tla.replace("MODULE Transfer", "MODULE Mutant").replace(guard, "b' = b + 1 /\\ inflight' = 1"));
  writeFileSync(join(dir, "Mutant.cfg"), cfg);
  const tlc = (name) => sh(dir, java, ["-cp", jar, "tlc2.TLC", "-config", `${name}.cfg`, `${name}.tla`]);

  const ok = tlc("Transfer");
  assert.equal(ok.status, 0, ok.stdout.slice(-1500));
  assert.match(ok.stdout, /No error has been found/);

  const mut = tlc("Mutant");
  assert.notEqual(mut.status, 0);
  assert.match(mut.stdout, /Invariant MoneyConserved is violated/);
});

// --- гейт сам гоняет модели spec/tla/ ---

import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { tempRepo, write, commit } from "./helpers.mjs";

const gateJar = [process.env.TLA2TOOLS, join(homedir(), ".agent-toolkit/tla/tla2tools.jar")].find((p) => p && existsSync(p));
const exampleModel = () => {
  const skill = readFileSync(join(kitRoot, "skills/formal-verification/SKILL.md"), "utf8");
  return { tla: skill.match(/```tla\n([\s\S]*?)```/)[1], cfg: skill.match(/```\n\\\* Transfer\.cfg\n([\s\S]*?)```/)[1] };
};
function repoWithModel(tla) {
  const dir = tempRepo({ gateConfig: { gates: [] } });
  mkdirSync(join(dir, ".agents/bin"), { recursive: true });
  cpSync(join(kitRoot, "tools/tlc.mjs"), join(dir, ".agents/bin/tlc.mjs"));
  const { cfg } = exampleModel();
  write(dir, "spec/tla/Transfer.tla", tla);
  write(dir, "spec/tla/Transfer.cfg", cfg);
  return dir;
}

test("гейт: модель в spec/tla есть, а TLC нет — коммит блокируется, а не проходит молча", () => {
  const dir = repoWithModel(exampleModel().tla);
  const r = commit(dir, "x [no-checklist]", { HOME: mkdtempSync(join(tmpdir(), "atk-h-")), TLA2TOOLS: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /гейт `tlc` упал/);
  assert.match(r.stderr, /нет tla2tools\.jar/);
});

test("гейт: правильная модель проходит TLC, мутант не даёт закоммитить", { skip: gateJar && hasJava ? false : "нужны java и tla2tools.jar" }, () => {
  const { tla } = exampleModel();
  const ok = repoWithModel(tla);
  const r = commit(ok, "x [no-checklist]", { TLA2TOOLS: gateJar });
  assert.equal(r.status, 0, r.stderr);
  const bad = repoWithModel(tla.replace("b' = b + 1 /\\ inflight' = 0", "b' = b + 1 /\\ inflight' = 1"));
  const r2 = commit(bad, "x [no-checklist]", { TLA2TOOLS: gateJar });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stdout + r2.stderr, /MoneyConserved is violated/);
});

test("гейт: проект без spec/tla — TLC не вмешивается", () => {
  const dir = tempRepo({ gateConfig: { gates: [{ name: "ok", run: "true" }] } });
  write(dir, "a.txt", "1");
  const r = commit(dir, "x [no-checklist]", { HOME: mkdtempSync(join(tmpdir(), "atk-h-")) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /tlc/);
});
