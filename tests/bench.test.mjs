import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitRoot, sh, write } from "./helpers.mjs";

const bench = join(kitRoot, "tools", "bench-compare.mjs");

function setup(baseline) {
  const dir = mkdtempSync(join(tmpdir(), "atk-bench-"));
  if (baseline) write(dir, ".agents/bench-baseline.json", JSON.stringify(baseline));
  const run = (current, ...args) => {
    write(dir, "cur.json", JSON.stringify(current));
    return sh(dir, "node", [bench, "cur.json", ...args]);
  };
  return { dir, run };
}

test("без базовой линии — создаётся, проход", () => {
  const { dir, run } = setup();
  assert.equal(run({ p95: 100 }).status, 0);
  assert.ok(existsSync(join(dir, ".agents/bench-baseline.json")));
});

test("медленнее больше чем на 10 % — не выкатываем; ровно 10 % — проходит", () => {
  const { run } = setup({ p95: 100 });
  assert.equal(run({ p95: 110 }).status, 0);
  const r = run({ p95: 111 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /не выкатываем/);
});

test("better: higher — падение throughput это регрессия", () => {
  const { run } = setup({ rps: { value: 1000, better: "higher" } });
  assert.equal(run({ rps: { value: 950, better: "higher" } }).status, 0);
  assert.equal(run({ rps: { value: 850, better: "higher" } }).status, 2);
});

test("пропавшая метрика — регрессия; порог настраивается", () => {
  const { run } = setup({ a: 100, b: 100 });
  assert.equal(run({ a: 100 }).status, 2);
  assert.equal(run({ a: 104, b: 100 }, "--max-regression", "3").status, 2);
});

test("ревью №14: базовая линия 0 — любое ухудшение это регрессия", () => {
  const { run } = setup({ errors: 0 });
  assert.equal(run({ errors: 0 }).status, 0);
  assert.equal(run({ errors: 1 }).status, 2);
});
