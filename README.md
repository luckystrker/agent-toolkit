# agent-toolkit

Рабочий набор скиллов, гейтов и инструментов для **агентской фабрики**: от входящего
бага или идеи до кода на проде — и еженедельного обучения фабрики на поправках владельца.
**Harness-agnostic**: базовые механизмы (AGENTS.md-индекс + git-хуки + CLI-инструменты на Node)
работают в любом агенте, нативные интеграции включаются там, где они есть.

## Пайплайн

```
входящее → triage ─┐
идея → research → grilling → domain-modeling → to-spec ─→ [formal-verification]
                                                   │
                         spec-to-checklist / to-tickets (доска tasks/*.md)
                                                   │
                     teamlead ─→ исполнители (tdd) ─→ проверка ДРУГОЙ моделью:
                                                      гейт → blast-radius → interrogate → acceptance
                                                   │
                             git commit (гейт-хук) ─→ release-train (замер скорости, глаза на проде)
сбоку: judge (до вопроса владельцу) · correct (поправка владельца) · reflect (каждое воскресенье)
       code-review · create-verification-skill · model-bench · handoff (конец сессии)
```

Подробно, со схемами доверия, ролей и общения агентов: [docs/pipeline.md](docs/pipeline.md).

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
| 21 скилл (список и триггеры — в секции-диспетчере) | `skills/` |
| Секция-диспетчер пайплайна для AGENTS.md (12 правил + индекс скиллов) | `agents/pipeline-section.md` |
| Гейт качества (git-хук + PreToolUse в одном файле) + commit-msg-хук | `gate/` |
| Общая доска задач, сообщения агентов, лог событий | `tools/board.mjs` → `<проект>/.agents/bin/` |
| Замер скорости против базовой линии (порог 10 %) | `tools/bench-compare.mjs` → `<проект>/.agents/bin/` |
| Примеры: адаптеры ZCode / Claude Code, `.agents/gate.json` | `adapters/` |
| Профиль пользователя (образец) | `profile/AGENTS-user.md` |
| Тесты тулкита (`npm test`, без зависимостей) | `tests/` |

Шаблоны артефактов (тезаурус, философия, ADR, PRD, журнал решений, роли и модели)
лежат рядом со скиллами, которые их создают. Скиллы `tdd`, `code-review`, `research` —
адаптация mattpocock/skills (MIT); остальные свои.

### Что со слайдов фабрики осталось за рамками тулкита

Инфраструктура, а не скиллы: чат с CTO-агентом из мессенджера, сеть машин (Tailscale),
панели агентов (herdr), общая история разговоров, сетевые протоколы между агентами (A2A),
запись экрана как сервис. Тулкит даёт точки подключения: дайджесты триажа и вопросы
судьи подаются инструментом выбора harness'а (бот мессенджера подключается проектом),
доказательства снимает проектный verify-скилл средствами harness'а, общий лог — `.agents/events.jsonl`.

## Установка

Node ≥ 18, без зависимостей.

```bash
# универсально: скиллы → <проект>/.agents/skills/, секция → AGENTS.md,
# git-хуки (гейт + проверка ссылки на чек-лист) → <проект>/.githooks/ (+ core.hooksPath)
node install.mjs --project C:/projects/my-project
# + .agents/bin/board.mjs и bench-compare.mjs (доска и замер скорости — только в project-режиме)

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

## Гейты качества

`gate/pre-commit` — один файл, два режима:

- **git pre-commit** (базовый): git вызывает файл сам — проверка обязательна
  независимо от того, кто коммитит: агент, человек из терминала, IDE, скрипт-обёртка.
- **PreToolUse-адаптер** (ZCode/Claude Code): читает JSON-payload из stdin, гейтит
  только `git commit` и **запрещает агенту обходить проверки**: `--no-verify`/`-n`,
  подмену `core.hooksPath`, самоодобрение через `AGENT_TOOLKIT_HUMAN_APPROVED`.

Порядок: (1) рабочее дерево = индекс (расхождение — блок с подсказкой `git add -A`);
(2) **защищённые пути** из `.agents/gate.json: protected` — необратимое (деньги, касса,
внешние системы, миграции): коммит только с `AGENT_TOOLKIT_HUMAN_APPROVED=1`, который
выставляет человек; (3) гейты по порядку, fail-fast, таймаут на каждый (120 с, настраивается).

Гейты — **любые команды** из `.agents/gate.json: gates` (Python, Go, Rust — что угодно),
иначе npm-скрипты `lint → typecheck → complexity → test → tlc`, какие объявлены.
Пример — `adapters/gate.json.example`. Нет ни того, ни другого — проход **с явным
предупреждением** (fail-open объявлен, а не молча). Коды: 0 = пропустить, 2 = блокировать.

`gate/commit-msg` — правило связности: если в корне есть `CHECKLIST.md`, сообщение
коммита содержит `CHECKLIST N.N` (merge/revert/fixup проходят; осознанный обход —
`[no-checklist]`). Нет `CHECKLIST.md` — хук неактивен.

Ограничения, названные честно:
- `git commit --no-verify` из терминала отключает git-хуки. У агента адаптер ловит
  `--no-verify` и его сокращения, `-n`, подмену `core.hooksPath`, самоодобрение — это
  защита от **случайного** обхода; команду можно спрятать в скрипт, адаптер видит только
  текст. Без адаптера (Codex, OpenCode, Pi, …) запрет обхода — правило в AGENTS.md.
- `AGENT_TOOLKIT_HUMAN_APPROVED` и `board --as human` (требует интерактивный терминал) —
  растяжки против ошибок агента, не защита от злоумышленника: `--as` — заявление, а не
  аутентификация, TTY можно эмулировать. Настоящий жёсткий шлюз для необратимого —
  защита веток и обязательное ревью владельца на сервере (CODEOWNERS, branch protection).
- Неотслеживаемые файлы блокируют коммит намеренно (тесты видят файл, коммит — нет).
  Рантайм доски (`.agents/events.jsonl`, `tasks/.locks/`) исключён и сам себя gitignore'ит;
  лог событий поэтому локален для машины, не история проекта.
- Невалидный `package.json` роняет хук в Node ещё до его кода (exit 1, стек Node) —
  коммит всё равно блокируется, но сообщение не наше.
- Существование отчёта приёмки, артефактов и отметки `[x]` — конвенция скиллов без автопроверки.
- Пример TLA+ в `formal-verification` проверяется тестом `tests/tla.test.mjs` (оригинал проходит TLC, мутант нарушает инвариант), но только при наличии Java и `TLA2TOOLS=<путь к tla2tools.jar>`; без них тест пропускается.

## Изменение и распространение

- Правки вносишь здесь — это канонический источник; установленное обновляется
  повторным запуском установщика (изменённое бэкапится с датой).
- Новые скиллы: папка `skills/<имя>/SKILL.md` (frontmatter: name, description) —
  установщик подхватит автоматически; добавь строку в индекс `agents/pipeline-section.md`.
- Исполняемый слой (гейт, доска, бенч, установщик) покрыт тестами: `npm test`.
- Версия — в `install.mjs`, `package.json` и [CHANGELOG.md](CHANGELOG.md); `node install.mjs --version`.
