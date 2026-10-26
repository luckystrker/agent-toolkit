# agent-toolkit

Рабочий набор скиллов и гейта качества для пайплайна разработки с AI-агентами:
от прожарки требований до приёмки кода и передачи сессии. **Harness-agnostic**:
базовые механизмы (AGENTS.md-индекс + git-хук) работают в любом агенте,
нативные интеграции включаются там, где они есть.

## Пайплайн

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

Подробно: [docs/pipeline.md](docs/pipeline.md).

## Совместимость

Три слоя: **AGENTS.md-индекс** (секция-диспетчер + скиллы в репо — читает любой агент),
**нативные скиллы** (автозагрузка в родной каталог harness'а), **гейт** (git-хук —
базовое принуждение; PreToolUse-адаптеры — опционально, ради статуса в интерфейсе).

| Harness | Индекс AGENTS.md | Нативные скиллы | Гейт: git-хук | Гейт: адаптер |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ `~/.claude/skills` | ✅ | ✅ `--claude-hook` |
| ZCode | ✅ | ✅ `~/.zcode/skills` | ✅ | ✅ `--zcode-hook` |
| Codex | ✅ | ✅ `~/.codex/skills` | ✅ | — |
| OpenCode | ✅ | ✅ (в т.ч. `.agents/skills` в проекте) | ✅ | — (свой плагинный API) |
| Pi | ✅ | через `--skills-dir` | ✅ | — (extensions) |
| Antigravity | ✅ | через `--skills-dir` | ✅ | — (Rules) |
| Qoder | ✅ (rules совместимы с AGENTS.md) | через `--skills-dir` | ✅ | — (Quest Mode) |
| Devin | ✅ (лимит 16 КиБ на весь AGENTS.md) | — (облако) | ✅ в его песочнице | — |

Источники: [agents.md](https://agents.md) · [Codex skills](https://simonwillison.net/2025/Dec/12/openai-skills/) · [OpenCode skills](https://opencode.ai/docs/skills) · [Antigravity rules](https://antigravity.google/docs/rules) · [Qoder rules](https://docs.qoder.com/user-guide/rules) · [Devin AGENTS.md](https://docs.devin.ai/onboard-devin/agents-md) · [Pi](https://pi.dev)

## Состав

| Что | Где |
|---|---|
| 7 скиллов (grilling, spec-to-checklist, tdd, acceptance, code-review, research, handoff) | `skills/` |
| Секция-диспетчер пайплайна для AGENTS.md | `agents/pipeline-section.md` |
| Гейт качества (git-хук + PreToolUse в одном файле) | `gate/pre-commit` |
| Примеры адаптеров ZCode / Claude Code | `adapters/` |
| Профиль пользователя (образец) | `profile/AGENTS-user.md` |

Скиллы `tdd`, `code-review`, `research` — адаптация mattpocock/skills (MIT); остальные свои.

## Установка

Node ≥ 18, без зависимостей.

```bash
# универсально: скиллы → <проект>/.agents/skills/, секция → AGENTS.md,
# git-хук гейта → <проект>/.githooks/ (+ core.hooksPath)
node install.mjs --project C:/projects/my-project

# то же + адаптеры статуса (по желанию, гейт они не дублируют по сути —
# это один и тот же gate/pre-commit, но блокирует до запуска команды)
node install.mjs --project C:/projects/my-project --zcode-hook --claude-hook

# пользовательский режим: скиллы + пайплайн-секция во все НАЙДЕННЫЕ harness'ы
# (claude / zcode / codex / opencode — по наличию их домашних каталогов)
node install.mjs

# то же + профиль-секция в пользовательские файлы инструкций
node install.mjs --profile

# Pi / Qoder / Antigravity — явный каталог:
node install.mjs --skills-dir ~/.pi/skills
```

Посмотреть план без изменений: добавь `--dry-run`. Откатить: `--remove` (с теми же флагами;
для проектного режима — `--remove --project <путь>`). Изменённые файлы перед перезаписью
копируются в `~/.agent-toolkit/backups/<дата>/`.

**Новый клон проекта:** настройка `core.hooksPath` живёт в локальном `.git/config`, а не в
репозитории — в каждом новом клоне (включая облачных агентов вроде Devin) выполни один раз
`node install.mjs --project .` или добавь в package.json `"prepare": "node install.mjs --project ."`.

## Гейт качества

`gate/pre-commit`, один файл, два режима:

- **git pre-commit** (базовый): git вызывает файл сам — проверка обязательна
  независимо от того, кто коммитит: агент, человек из терминала, IDE, скрипт-обёртка.
- **PreToolUse-адаптер** (ZCode/Claude Code): читает JSON-payload из stdin, гейтит
  только `git commit`. Остаточный риск текстового матчинга (обёртка с `git commit`
  внутри) закрывается именно git-хуком.

Что делает: сверяет рабочее дерево с индексом (тесты обязаны проверять то, что
коммитится; расхождение — блок с подсказкой `git add -A`); прогоняет
`npm run --if-present lint|typecheck|test` с fail-fast и таймаутом 120 с на гейт.
Проект без package.json или гейт-скриптов проходит **с явным предупреждением**
(fail-open объявлен, а не молча). Коды: 0 = пропустить, 2 = блокировать.

Гейт генеричен к стеку в пределах npm-скриптов; не-npm проекты сейчас без гейта —
это известное ограничение, не молчаливое.

## Изменение и распространение

- Правки вносишь здесь — это канонический источник; установленное обновляется
  повторным запуском установщика (изменённое бэкапится с датой).
- Новые скиллы: папка `skills/<имя>/SKILL.md` (frontmatter: name, description) —
  установщик подхватит автоматически; добавь строку в индекс `agents/pipeline-section.md`.
- Версия — в `install.mjs` и [CHANGELOG.md](CHANGELOG.md); `node install.mjs --version`.
