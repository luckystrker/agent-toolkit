// Пример TLA+ из скилла formal-verification обязан: (1) проходить TLC, (2) краснеть на мутанте
// из того же скилла. Нужны java и tla2tools.jar (env TLA2TOOLS=<путь к jar>); иначе тест пропускается.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitRoot, sh } from "./helpers.mjs";

const jar = process.env.TLA2TOOLS;
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
