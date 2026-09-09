# План эксперимента LongCLI-Bench на Codex

Статус: **отложен, запуск не выполнялся**
Дата фиксации: 2026-09-04

Уточнение 2026-09-09: ниже сохранена историческая инженерная записка. Научные режимы, выборка,
повторы и правила анализа пересмотрены в [актуальном плане исследования](./RESEARCH-ARTICLE-PLAN.md).
Старая матрица этой записки не является протоколом следующей научной серии; ресурсы и upstream
перед возобновлением нужно проверить заново. Нового запуска не было.

## Цель

Сравнить три runtime-режима одного и того же модифицированного Codex на длинных автономных CLI-задачах:

- `baseline` — штатный transcript loop;
- `paper` — исходный контракт статьи `P + Sigma_n + O_n`;
- `v2` — `P + Sigma_n + O[n..n-k]`, структурированные observations и `comment`, при `k=3`.

Во всех cells должна использоваться модель `gpt-5.6-sol` с `model_reasoning_effort="high"`. Эксперимент нужен для
проверки качества, длины trajectories и реальной экономии токенов на существенно более длинном горизонте, чем пять
текущих greenfield-задач.

## Зафиксированный источник

- Официальный репозиторий: [finyorko/longcli-bench](https://github.com/finyorko/longcli-bench).
- Статья: [LongCLI-Bench](https://aclanthology.org/2026.findings-acl.1497.pdf).
- Проверенный upstream commit: `2015f37b5c458f2562354de6b415e9182c91af64`.

При возобновлении сначала проверить состояние upstream. Для воспроизводимого основного прогона использовать
закреплённый commit либо отдельно задокументировать переход на более новый revision.

## Состав benchmark

Официальный batch-список содержит 20 задач:

- 9 лабораторных MIT 6.1810 по xv6: C/Assembly, copy-on-write fork, файловая система, блокировки, `mmap`, E1000,
  таблицы страниц, системные вызовы, потоки и traps;
- 5 проектов Berkeley CS61A: Ants, Cats, Hog, Scheme interpreter и Scheme homework;
- 3 проекта CMU 15-445 BusTub: C++ primer, buffer pool и B+Tree;
- 2 составные C++-задачи AP1400;
- 1 задача на расширение самого Terminal-Bench режимом `long_cli`.

В checkout также есть `61810_util`, но она не входит в официальный default batch. Нельзя незаметно добавлять её в
основной набор: это изменит знаменатель и сделает результаты несопоставимыми.

Оценивание включает:

- `F2P` — выполнение новых требований;
- `P2P` — отсутствие регрессий;
- бинарный общий pass;
- частичные step scores.

## Матрица запуска

Основной первый этап — single-turn/pass@1:

```text
20 tasks x 3 runtime modes x 1 attempt = 60 cells
```

`--give-test-output` должен оставаться равным `1`: одна попытка LongCLI уже содержит длинный внутренний tool loop
Codex. Дополнительные внешние self-correction turns создают новые сессии и смешивают эффект ядровой памяти с
инъекцией результатов тестов harness.

После анализа pass@1 при наличии смысла запускается устойчивость/pass@3:

```text
20 tasks x 3 runtime modes x 3 independent attempts = 180 cells
```

Отдельный multi-turn/self-correction эксперимент возможен позднее, но не входит в первоначальное A/B/C.

## Инварианты честного A/B/C

1. Во всех режимах используется один Linux-бинарник Codex с одинаковым SHA-256.
2. Отличается только `CODEX_SKILL_STATE_MODE=baseline|paper|v2`.
3. Для `v2` явно задаётся `CODEX_SKILL_STATE_OBSERVATION_WINDOW=3`; `paper` всегда использует только последнее `O_n`.
4. Модель, reasoning effort, исходный task image, prompt, timeout, тесты и сетевой маршрут одинаковы.
5. Не более двух одновременно работающих runner.
6. Режимы запускаются блоками по задаче с чередованием или заранее зафиксированной рандомизацией порядка, чтобы
   rate limits и временной drift не систематически приходились на один режим.
7. Failed, timed-out и infrastructure-failed cells не считаются экономией токенов. Они отражаются отдельно и при
   необходимости перезапускаются по заранее определённому правилу.
8. Результаты, созданные до внешнего тестирования, не получают скрытые тесты или их ответы в prompt.

## Требуемая интеграция harness

Официальный Codex adapter устанавливает свежий `@openai/codex` внутрь каждого task container. Это не подходит для
исследования ядровой модификации. Нужно:

1. Собрать текущее исследовательское ядро Codex под Linux `aarch64` в отдельном Docker builder.
2. Не смешивать Linux artifacts с существующим macOS `codex-rs/target`.
3. Подключать собранный бинарник в task container через compose override или отдельный LongCLI agent adapter.
4. Отключить установку upstream npm Codex и проверить `codex --version`/hash до каждой cell.
5. Явно передавать runtime mode, observation window и high reasoning в процесс агента.
6. Запускать `codex exec` с JSONL-выводом либо расширить parser так, чтобы usage извлекался без потери разбиения по
   input, cached input, output и reasoning tokens.
7. Сохранять rollout/state-transition artifacts из container в каталог конкретной cell.
8. Добавить `doctor`, проверяющий Docker, архитектуру бинарника, его hash, модель, mode, auth, writable mounts,
   task image и доступность evaluator до расходования модельных токенов.

Изменять ядро `baseline`, `paper` или `v2` ради LongCLI не планируется. Интеграция должна находиться в benchmark
harness/adapter и не менять семантику уже протестированных режимов.

## Собираемые метрики

Для каждой cell:

- общий pass, `F2P pass`, `F2P step score`, `P2P pass`, `P2P step score`;
- wall time и причина завершения;
- provider samples/tool steps;
- input, cached input, uncached input, output, reasoning и total tokens;
- размер `Sigma` по шагам и размер provider-visible prompt;
- число accepted/rejected `skill_step` transitions;
- повторяющиеся действия, protocol violations, timeouts и premature finish;
- SHA-256 бинарника, commit Codex, commit LongCLI, mode, `k`, модель и reasoning effort.

Для `paper` и `v2` после запуска требуется аудит нескольких provider-visible сессий: проверить, что transcript и
старое reasoning действительно не возвращались модели, `paper` видел ровно одно последнее observation, а `v2` — не
более трёх структурированных observations.

Итоговый отчёт должен содержать как macro-результаты по 20 задачам, так и paired delta для каждой задачи. Абсолютные
tokens и качество показываются вместе: незавершённый дешёвый run не является выигрышем.

## Порядок возобновления

1. Освободить место и поднять Docker/Colima.
2. Собрать и проверить Linux-бинарник.
3. Реализовать adapter и `doctor`.
4. Выполнить smoke на одной дешёвой задаче во всех трёх режимах.
5. Выполнить пилот на трёх задачах разных типов:
   - `61810_cow` — xv6/C и длинная системная модификация;
   - `cs61_fa24_ants` — Python/OOP и много требований;
   - `cmu15_445_p1` — C++/BusTub и тяжёлая сборка.
6. Проверить качество артефактов, корректность prompt reconstruction и token accounting.
7. Запустить 60-cell pass@1 с checkpoint/resume.
8. Решить по результатам, нужен ли 180-cell pass@3.

## Текущие инфраструктурные ограничения

На момент фиксации:

- Docker/Colima установлена, но остановлена;
- профиль Colima — `aarch64`, 2 CPU и 2 GiB RAM, что недостаточно комфортно для сборки Codex и тяжёлых C++ tasks;
- на host filesystem свободно около 3.6 GiB;
- существующий rebuildable `codex/codex-rs/target/debug` занимает около 20 GiB;
- данные Colima занимают около 87 GiB;
- готовый Codex binary имеет формат macOS Mach-O ARM64 и не может исполняться в Linux task containers;
- `OPENAI_API_KEY`/`OPENAI_BASE_URL` в текущем shell отсутствуют;
- локальный ChatGPT/Codex auth существует, но не должен копироваться в benchmark containers без отдельного явного
  решения пользователя: произвольный agent shell внутри контейнера потенциально способен прочитать credential.

Перед стартом желательно иметь не менее 20–30 GiB свободного места и увеличить Colima примерно до 4+ CPU и 8+ GiB
RAM, если ресурсы host позволяют. Удаление build cache, pruning/recreation Colima и перенос auth являются отдельными
операциями и не разрешены этой запиской.

## Оценка масштаба

- подготовка Linux build, adapter, doctor и smoke — несколько инженерных часов;
- пилот из 9 cells — несколько часов выполнения;
- 60-cell pass@1 — ориентировочно один рабочий день с двумя runner, но отдельные tasks имеют timeout 2–3 часа;
- 180-cell pass@3 — ориентировочно один-два дня либо дольше с учётом rate limits и повторов инфраструктурных ошибок.

Это оценка, а не SLA. Перед полным запуском её нужно обновить по фактическим времени и token usage пилота.

## Условие снятия с паузы

Эксперимент остаётся отложенным до отдельной команды пользователя. При возобновлении нужны два явных решения:

1. какой rebuildable cache разрешено удалить или перенести для освобождения места;
2. какой безопасный способ аутентификации использовать внутри эфемерных Docker containers.
