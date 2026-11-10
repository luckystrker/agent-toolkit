#!/usr/bin/env node
// Автоматизация «Новые модели» (еженедельно). Сравнивает модели всех доступных bb-провайдеров
// со снимком прошлой недели. Появились новые — тред-оркестратор под скилл model-bench:
// стоит ли сравнивать их с текущими агентами на своих задачах; решение — за владельцем.
// Первый запуск только сохраняет снимок. Ничего нового — пустой вывод (тихий тик).
import { bbJson, readState, spawnOrchestrator, writeState } from "./lib.mjs";

const providers = (bbJson(["provider", "list"]) ?? []).filter((p) => p.available !== false).map((p) => p.id);
if (providers.length === 0) { console.error("bb provider list ничего не вернул — проверить модели нельзя"); process.exit(1); }

const now = {};
for (const id of providers) {
  const d = bbJson(["provider", "models", id]);
  const list = Array.isArray(d) ? d : d?.models;
  if (list) now[id] = list.map((m) => m.id ?? m.model).filter(Boolean).sort();
}

const prev = readState("models-snapshot.json", null);
writeState("models-snapshot.json", { at: new Date().toISOString(), models: now });
if (!prev) process.exit(0); // первый запуск — точка отсчёта

const fresh = [];
for (const [id, models] of Object.entries(now)) {
  const before = new Set(prev.models?.[id] ?? []);
  if (!prev.models?.[id]) continue; // провайдер появился целиком — не считаем каждую его модель новинкой
  for (const m of models) if (!before.has(m)) fresh.push(`${id}: ${m}`);
}
if (fresh.length === 0) process.exit(0);

console.log(`[новые модели] ${fresh.length}:\n${fresh.join("\n")}`);
const spawned = spawnOrchestrator({
  title: `Новые модели в bb: ${fresh.length}`,
  prompt: `Еженедельная проверка нашла в bb новые модели (с ${prev.at}):
${fresh.map((f) => `- ${f}`).join("\n")}

Ты — оркестратор (роль из CLAUDE.md). Сравни их с текущими агентами фабрики (\`node ~/.agent-toolkit/bin/factory.mjs workers\`):
1. Отсей очевидно неподходящее (не для кода, превью без гарантий) — с причиной одной строкой.
2. Для остальных предложи владельцу план бенчмарка по скиллу model-bench: на каких наших задачах, против какого агента, сколько это стоит по времени.
3. Сам factory.json не меняй и бенчмарк не запускай без «да» владельца — состав агентов решает он.`,
});
console.log(spawned.ok ? `Заведён тред: ${spawned.thread}` : `Тред завести не удалось: ${spawned.error}`);
process.exit(spawned.ok ? 0 : 1);
