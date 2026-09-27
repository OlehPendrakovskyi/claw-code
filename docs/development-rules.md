# Правила разработки (выведены из ретроспективы claw-code, 2026-09-27)

Основа: PR #8/#10 (Sprint 1-2), PR #11 MVP (28 раундов Copilot, ~90 находок, ~25 фикс-коммитов, сутки на исправления).

## Общие правила (любой проект)

1. **Владение ресурсом проектируется до кода.** Для каждого изменяемого ресурса (сокет, колбэк, буфер, run) — один владелец, явный lifecycle (register/retire/replace) и документированная семантика. Несколько карт с разными ключами на один ресурс = будущие гонки.

2. **Каждый `await` — граница перехода состояния.** После каждого await — ревалидация предусловий (сущность ещё активна, поколение не сменилось, владение сохранено). Идентификаторы поколения/эпохи захватывать ДО await, сравнивать ПОСЛЕ.

3. **Монотонные epoch/generation для всей async-инвалидации.** Бамп ДО деструктивных операций (abort/close), проверка ПЕРЕД применением результата. Терминальные события (done/close) идемпотентны.

4. **Promise никогда не проверяется как boolean.** Async-валидация — только через await. Непроверенный Promise всегда truthy.

5. **Недоверенный ввод валидируется на каждой границе доверия** — семантически (не только shape), и повторно после каждого await, если данные контролируемы извне.

6. **Файловая система — чеклист:** realpath при ingestion → проверка containment → open с O_NOFOLLOW (+O_NONBLOCK для возможно-специальных файлов) → fstat-vs-lstat (dev/ino) + isFile() → ревалидация после await. Check-then-use по умолчанию гонка. Остаточные окна честно документировать с указанием ответственного компонента.

7. **Тесты проверяют интерливинги, а не happy path:** send во время abort, rebind во время send, reconnect во время run, дубликаты кадров. Каждый исправленный race получает регресс-тест, падающий без фикса. Тест, кодифицирующий неверное поведение — баг; при смене семантики перечитывать тестовые контракты.

8. **Цикл «пуш → N находок» — симптом дизайна, не кода.** Если раунд ревью находит проблемы в свежем фиксе — остановиться и пересмотреть архитектуру, а не латать. Само-ревью с adversarial-оптикой ДО пуша дешевле суток фикс-циклов.

9. **Мелкие сфокусированные PR.** Большой PR (12 коммитов, concurrency-ядро) = часы ревью и churn. Ядро конкурентности — отдельным PR с собственным дизайном.

10. **Гигиена логов:** никогда не логировать секреты/промпты/содержимое файлов; только счётчики, ключи, id.

11. **Инфраструктура фоновых процессов:** интервал ≥ максимальной длительности прогона (наложения недопустимы); durable-маркеры прогресса; single-flight.

## Специфика claw-code (VS Code extension + OpenClaw gateway)

1. **Модель владения session/thread:** run sink vs transcript sink vs persistent callback; ключ колбэков — thread id (треды делят сессии). abort/clear/reset только при `status==='running'` и локальном владении (`hasOwnedRun`); никогда не абортить за idle-подписчиков.

2. **Инварианты стриминга:** кадры могут omit messageId; delta vs text vs mixed (cumulative/divergent); дедуп complete-кадров claim-before-dispatch; seen-set хранит только complete assistant rows; catch-up гейтится на cursor + `allowUnscopedCatchUp` только для no-history путей; pre-ack буфер атрибутируется конкретному send; `chat.send` только после ack подписки; `done` идемпотентен.

3. **Config/SecretStorage:** токен только в SecretStorage; миграция перебирает ВСЕ targets (user/workspace/folder × normal/language × Code/Code-OSS/VSCodium/Insiders + .code-workspace nested); per-folder update в multi-root; scope из @types/vscode — `{languageId, uri?}` (поля folderUri нет); tri-state результат миграции, ретрай incomplete, не кэшировать неудачу; deprecated-настройки регистрировать в package.json.

4. **Webview:** только createElement/textContent (никакого innerHTML с данными); интерактивные строки — button (a11y); ключи сессий из webview валидировать против sessions.list allowlist (awaited); emitState после каждого await, меняющего рендер.

5. **Пути/вложения:** containment на resolve И на read; O_NOFOLLOW + O_NONBLOCK + isFile + dev/ino + recheck после await; slash-команды используют те же guard'ы, что handleSend.

6. **Процесс репо:** явный fetch ветки (refspec-гигиена, `git remote prune`), rebase на remote tip перед пушем (проверка ls-remote), Conventional Commits, гейты перед каждым коммитом, `jest --forceExit`; Copilot-протокол: верифицировать каждую находку по HEAD (снапшоты часто устаревшие), отвечать в каждый тред, резолвить треды, стоп-правило при раунде без коммитов, проверять секции Open/Previously missed в телах обзор-ревью.

## Классы багов PR #11 (для будущих ревью-чеклистов)

- Stale continuation после await (generation не захвачен/не проверен) — ~15 находок
- Дублированная доставка (live + catch-up + pre-ack buffer без атрибуции) — ~10
- Over/under-aggressive teardown (ретайр всех sink'ов vs утечка колбэков) — ~8
- Path traversal / symlink TOCTOU / спец-файлы / case-сравнения — ~8
- Смешанные кадры delta+text (потеря/дублирование текста, отравление seen-set) — ~6
- Миграция токена (scope-семантика, multi-root, language-override, дистро-пути) — ~8
- Async-валидация без await (allowlist обход) — ~3
- Фиксы, вводящие новые баги (settled-first, union-ретайр) — ~4