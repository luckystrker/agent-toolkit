# agent-toolkit

Рабочий набор скиллов и хуков для пайплайна разработки с AI-агентами:
от прожарки требований до приёмки кода и передачи сессии.
Собран и обкатан на проекте dio-agent (этапы 0–5, каждый этап принимался
полным циклом: тестировщик → критик → мутационная проверка → гейт).

## Состав

| Что | Где | Происхождение |
|---|---|---|
| Скилл `grilling` | `skills/grilling/` | Свой. Интервью «один вопрос за раз» до границы знания |
| Скилл `spec-to-checklist` | `skills/spec-to-checklist/` | Свой. Спека/архитектура → этапы с критериями Г/Р |
| Скилл `acceptance` | `skills/acceptance/` | Свой. Цикл приёмки: тестировщик → критик (мутации, PBT) → гейт |
| Скилл `tdd` | `skills/tdd/` | Адаптация mattpocock/skills (MIT): перевод, без трекер-зависимостей |
| Скилл `code-review` | `skills/code-review/` | Адаптация mattpocock/skills (MIT): две оси, источники под наши конвенции |
| Скилл `research` | `skills/research/` | Адаптация mattpocock/skills (MIT): под ZCode-инструменты |
| Скилл `handoff` | `skills/handoff/` | Свой. Компактация сессии в HANDOFF.md |
| Хук pre-commit-gate | `hooks/pre-commit-gate.mjs` | Свой. Гейт качества перед `git commit`: lint/typecheck/test |
| Профиль пользователя | `profile/AGENTS-user.md` | Свой. Образец `~/.zcode/AGENTS.md` |
| Конфиг хука | `config/zcode-hooks.json.example` | Пример подключения хука в проект |

## Пайплайн (как скиллы связаны)

Подробно: [docs/pipeline.md](docs/pipeline.md). Кратко:

```
требования размыты ──→ grilling ──→ spec-to-checklist ──→ реализация (tdd)
                                                │                  │
                                                │                  ▼
                                                │            acceptance (тестировщик→критик→гейт)
                                                │                  │
                                                ▼                  ▼
                                          git commit ── хук-гейт ──► коммит
                                                                       │
                                                            конец сессии → handoff
```

## Установка

Всё ставится одним скриптом (Node ≥ 18, без зависимостей):

```bash
# скиллы → ~/.zcode/skills/ (актуализирует существующие)
node install.mjs

# то же + хук качества в конкретный проект (.zcode/hooks/ + config.json)
node install.mjs --project C:/projects/my-project

# то же + профиль пользователя → ~/.zcode/AGENTS.md
node install.mjs --profile
```

Что именно делает скрипт — см. в самом `install.mjs` (читаемый, ~100 строк).

## Изменение и распространение

- Правки вносишь здесь — это канонический источник; установленные копии в
  `~/.zcode/skills/` обновляются повторным запуском `node install.mjs`.
- Новые скиллы: папка `skills/<имя>/SKILL.md` (frontmatter: name, description).
- Хук генеричен к стеку: сам находит package.json и запускает существующие
  скрипты `lint` / `typecheck` / `test` через `npm run --if-present`;
  без package.json молча пропускает.

## Статус

Обкатан на dio-agent: 226 юнит + 209 БД тестов, мутационные проверки критика
на каждом этапе. Скиллы процесса (интерактивные) проверены живым
использованием в сессиях, не автоматическим бенчмарком.
