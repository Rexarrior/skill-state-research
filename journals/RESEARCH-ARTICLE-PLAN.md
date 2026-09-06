# План научного продолжения SKILL.state

Статус: **исследовательская гипотеза и проект протокола; confirmatory experiments не начинались**
Дата фиксации: 2026-09-04

## Краткий вывод

Продолжение имеет научный смысл, если исследовать не частный вопрос «помогает ли `k=3`», а границы основного
предположения SKILL.state: когда модельно поддерживаемое execution state действительно является достаточной
статистикой истории. Простое добавление последних нескольких действий и комментария полезно инженерно, но близкие
гибриды долговременной и краткосрочной памяти уже существуют. Потенциальный вклад этой работы — контролируемая карта
режимов, причинное разложение компонентов state-протокола и минимальная commit-aware модификация для случаев с
отложенной релевантностью.

Текущие результаты OpenCode и Codex используются только как **exploratory pilot study** и источник гипотез. Они не
должны становиться confirmatory evidence будущей статьи: задачи и параметры уже менялись после просмотра результатов,
каждая основная cell имеет `n=1`, а часть сравнений смешивает memory representation с гранулярностью инструментов.

## Дополнение из аудита технической статьи

2026-09-04/05: новая серия включает дополнительные повторы Codex V2/V3, но остаётся пилотом. До confirmatory-прогонов
нужно отдельно зафиксировать чистое окружение без профиля рабочего хоста, пользовательских каталогов справочников и
автоматически подмешанных рекомендаций плагинов. Флаг `--ignore-user-config` сам по себе этого не обеспечил.
В нынешнем Codex state начальные инструкции объединяются внутри P с текстовыми метками ролей, а Native сохраняет
API-роли: следующий контроль должен сохранять одинаковую иерархию system/developer/user и явно проверять
provider-visible запросы. Также фиксируются схема состояния, transport, action space, разрешения, вспомогательные
reviewer-вызовы и правила усечения. См. [аудит соответствия](../experiments/PAPER-CONFORMANCE.md) и
[журнал подготовки статьи](./ARTICLE-20260904.md).

Нужен и сильный доменный Paper-контроль: в авторской CTF-схеме есть модельно поддерживаемое `cmd_summary`, а текущая
coding schema использует другой набор полей. До сравнения с runtime-owned наблюдениями зафиксировать общий для домена
вариант Sigma с явной памятью о команде и проверить его отдельным контролем. Нельзя объявлять недостатком исходной
архитектуры то, что может быть следствием выбранной нами схемы. Научные задачи остаются новыми, не этими пятью.

## Исходная гипотеза и её границы

[SKILL.state](https://arxiv.org/html/2608.26263v2) строит каждый следующий запрос как:

```text
A_t = (P, Sigma_t, O_t)
```

где `P` — неизменная постановка, `Sigma_t` — структурированное execution state, а `O_t` — последнее наблюдение.
Предыдущие действия, observations и reasoning traces удаляются из provider-visible context. Модель возвращает
`state_patch + action`, runtime валидирует patch, обновляет `Sigma` и только затем выполняет действие.

Это даёт линейный суммарный input только при двух дополнительных условиях:

1. всё, что понадобится в будущем, своевременно и корректно переносится в `Sigma`;
2. размер достаточного `Sigma_t` ограничен независимо от горизонта `T`.

Авторы прямо указывают, что первое условие нарушается при неизвестной заранее schema, при позднем обнаружении
релевантности старого observation и в задачах, где сама trajectory является результатом. Второе условие следует из
их же оценки `O(|P| + |Sigma| + |O|)`: если количество независимых незавершённых обязательств растёт вместе с `T`,
lossless state также может расти как `Omega(T)`, и безусловного `O(1)` prompt уже нет.

## Научное позиционирование

Ближайшие направления уже покрывают значительную часть очевидных улучшений:

- [HiAgent](https://aclanthology.org/2025.acl-long.1575/) сохраняет подробные action-observation pairs текущей
  подзадачи, а завершённые подзадачи сворачивает в summaries;
- [Context as a Tool](https://arxiv.org/abs/2512.22087) использует stable task semantics, condensed long-term memory и
  последние `k` высокоточных ReAct-шагов;
- [PRO-LONG](https://arxiv.org/abs/2607.20064) сохраняет полный structured interaction log вне активного context и
  позволяет coding agent программно искать по нему;
- [MemexRL](https://arxiv.org/abs/2603.04257) соединяет компактные summaries со стабильными индексами на точные
  прошлые взаимодействия;
- [VISTA](https://arxiv.org/abs/2606.30005) предоставляет модели типизированные адресуемые блоки, сведения об их
  размере и давности и восстановимый full-fidelity архив;
- [ReTree](https://arxiv.org/abs/2608.10676) сохраняет provenance и перестраивает зависимые summaries после
  обнаружения противоречащего evidence;
- [Masking Stale Observations](https://arxiv.org/abs/2606.00408) показывает, что польза удаления старых observations
  зависит от сочетания силы модели и качества retrieval;
- [AdaCoM](https://arxiv.org/abs/2605.30785) обучает внешний context manager и обнаруживает trade-off между fidelity и
  reliability для агентов разной силы.

Поэтому отдельные элементы `Sigma + recent k`, external log или retrieval сами по себе не являются достаточной
новизной. Работа должна позиционироваться прежде всего как исследование **boundary conditions and causal mechanisms**
для атомарного контракта SKILL.state. Предлагаемая модификация — минимальный предмет экспериментальной проверки, а не
заявка на изобретение всей гибридной памяти.

## Предлагаемый тезис статьи

> Structured execution state эффективно в задачах с компактным достаточным состоянием. Его надёжность предсказуемо
> падает при отложенной релевантности, state aliasing и росте числа независимых обязательств. Небольшой слой bounded
> episodic memory восстанавливает часть надёжности, сохраняя линейный cumulative model input, но создаёт измеримый
> fidelity-efficiency trade-off.

Рабочие варианты названия:

- **When Is Execution State Sufficient? Reliability-Efficiency Trade-offs in Long-Horizon LLM Agents**
- **The Price of Forgetting: Boundary Conditions for Structured Agent State**
- **Beyond the Latest Observation: Robust Structured State for Long-Horizon Agents**

## Формализация предлагаемой модификации

Полный журнал событий хранится вне prompt:

```text
E_t = append_only(O_1, ..., O_t)
```

Активный запрос получает:

```text
A_t = (P, Sigma_t, U_t, R_t)
```

где:

- `Sigma_t` — долговременное структурированное состояние;
- `U_t` — bounded-буфер ещё не поглощённых observations;
- `R_t` — опциональный bounded-результат восстановления точного evidence из `E_t`;
- `E_t` — полный аудитный журнал размером `O(T)`, не включаемый целиком в prompt.

Runtime формирует observation самостоятельно:

```json
{
  "id": 17,
  "action": {
    "name": "exec_command",
    "summary": "python3 -m py_compile main.py"
  },
  "status": "success",
  "result": "Action completed without textual output",
  "intent": "Check syntax before running tests"
}
```

`action`, `status` и `result` принадлежат runtime и не должны реконструироваться моделью. `intent`/`comment` остаётся
опциональным модельным полем и проверяется отдельной абляцией.

Ответ модели расширяется операциями жизненного цикла observation:

```json
{
  "state_patch": {},
  "absorbed_observations": [17],
  "retain_observations": [],
  "retrieve": [],
  "action": {}
}
```

Observation удаляется из `U` после явного absorption. В строгом варианте runtime требует, чтобы поглощённый observation
был связан с обновлённым state field через source reference либо явно признан нерелевантным. При превышении byte/token
budget запись выталкивается в адресуемый архив, а не уничтожается. Размеры `U_t` и `R_t`, число retrieval operations и
объём каждого ответа должны иметь фиксированные верхние границы; иначе утверждение о bounded prompt не выполняется.

Рабочее название механизма: **commit-aware execution state**. До экспериментов его нельзя называть улучшением:
возможны преждевременные acknowledgements, лишние retrieval calls и рост протокольного overhead.

## Исследовательские вопросы

### RQ1. Crossover

При каком горизонте `T*` state-протокол становится дешевле transcript при сопоставимом качестве и одинаковой
гранулярности действий?

### RQ2. Компоненты observation

Какой независимый вклад дают identity действия, bounded input summary, status, model-authored comment и размер окна?

### RQ3. Достаточность state

Как delayed relevance, state collision и рост числа независимых обязательств влияют на качество и размер `Sigma`?

### RQ4. Политика хранения

Когда fixed recent window достаточно, а когда commit-aware retention и retrieval окупают дополнительный input?

### RQ5. Модель и action space

Как эффект зависит от способности модели соблюдать structured protocol и от atomic/batched action granularity?

## Проверяемые гипотезы

- **H1:** runtime-owned action identity и status снижают повторение успешно выполненных silent actions относительно
  result-only `O_t`.
- **H2:** fixed window улучшает качество, только пока расстояние до отложенно релевантного evidence не превышает
  фактическую ёмкость окна.
- **H3:** comment даёт меньший и менее стабильный вклад, чем runtime-owned action metadata, и может переносить
  ошибочную гипотезу между шагами.
- **H4:** commit-aware buffer превосходит fixed `k` при delayed relevance под одинаковым active-context budget.
- **H5:** archive retrieval нужен при delay больше active budget, но уступает чистому state на полностью Markov-задачах
  из-за дополнительных samples и токенов.
- **H6:** в задачах с `N` независимыми незавершёнными обязательствами размер lossless `Sigma` растёт с `N`; линейный
  cumulative input SKILL.state не является универсальной гарантией.
- **H7:** после выравнивания action space часть различий между transcript и state уменьшится; batching остаётся
  отдельным значимым фактором.

## Экспериментальный дизайн

### 1. Заморозить pilot study

- Пометить существующие OpenCode/Codex suites как exploratory.
- Создать неизменяемый tag текущего состояния после отдельного решения о коммите накопившихся изменений.
- Не использовать существующие `n=1` результаты для выбора confirmatory reporting rules.
- Сохранить их только как мотивацию H1, H3 и H7.

### 2. Выравнять harness

До сравнения памяти baseline и state должны иметь:

- одинаковый бинарник и commit;
- одинаковые direct tools и schemas;
- одинаковую atomic либо batched гранулярность;
- одинаковый максимум environment actions и provider samples;
- одинаковые system instructions, task prompt, reasoning effort и sampling parameters;
- одинаковые timeout/retry rules;
- независимые mutable environments;
- заранее рандомизированный или сбалансированный порядок cells.

State validation, finish semantics, permission model и result truncation должны быть общими для всех state arms. Эти
механизмы не следует менять одновременно с исследуемой формулой памяти.

### 3. Независимая абляция формата одного observation

На первом этапе всегда используется `k=1` и одинаковая `Sigma` schema:

| Arm | Provider-visible `O_t` |
|---|---|
| `O0` | `result` |
| `O1` | `action name + status + result` |
| `O2` | `action name + bounded input summary + status + result` |
| `O3` | `O2 + comment/intent` |

Это отделяет наблюдавшийся silent-action loop от влияния окна. Для больших patches input summary должен содержать
путь, тип операции, размер и digest, а не полный payload.

### 4. Абляция окна

На лучшем формате observation сравнить:

```text
k in {1, 2, 3, 5, 8}
```

Нужны две серии:

1. естественная — больший `k` получает больше токенов;
2. token-matched — каждое окно ограничено одинаковым общим budget.

### 5. Абляция долговременного state

Отдельно проверить:

- наличие/отсутствие `verification` в `Sigma`;
- наличие/отсутствие source/provenance references;
- свободный recursive patch против typed patch operations;
- фиксированную domain schema против ограниченно расширяемой schema.

Замена `verification` на `comment` состоит из двух независимых изменений и не должна снова оцениваться одним arm.

### 6. Абляция политики хранения

Сравнить под одинаковым active-context budget:

- последнее observation;
- fixed recent `k`;
- commit-aware pending buffer;
- commit-aware buffer + bounded archive retrieval.

### 7. Отдельная проверка batching

Провести факторный эксперимент:

| Memory | Atomic tools | Sequential batch |
|---|---:|---:|
| Transcript | yes | yes |
| Structured state | yes | yes |

Так можно отделить экономию prompt от изменения числа provider samples. V3 остаётся pilot implementation этой идеи,
но confirmatory arms должны использовать новый замороженный protocol.

Полный factorial всех параметров на frontier-моделях слишком дорог. Сначала применяется полный или fractional
factorial на дешёвых/open-weight моделях и контролируемых средах. После этого заранее выбирается небольшой набор
confirmatory arms для всех целевых моделей. Выбор нельзя менять после просмотра confirmatory results.

## Контролируемые диагностические задачи

### Silent success

Варьировать долю успешных действий без stdout. Правильный следующий шаг зависит от identity только что выполненного
действия. Основные метрики: consecutive repeat rate, steps-to-finish и task success.

### Delayed relevance

Observation появляется на шаге `t`, но его значение раскрывается через:

```text
d in {0, 1, 3, 5, 8, 16, 32}
```

До раскрытия evidence должно выглядеть правдоподобно нерелевантным. Явный alert об изменении нельзя использовать во
всех samples, иначе задача будет проверять реакцию на подсказку, а не сохранение памяти.

### State collision

Генерируются две истории `h` и `h'`, которые lossy updater отображает в одинаковые `(P, Sigma_t, O_t)`, хотя
правильные следующие действия различаются. Политика, видящая только одинаковый input, принципиально не может правильно
различить обе истории. Это позволяет отделить информационную недостаточность representation от общей силы модели.

### Contradiction and drift

Ранний факт тихо становится неверным. Измеряются stale-state actions, recovery lag, исправление зависимых state fields
и provenance-grounded recovery.

### Growing obligations

Каждый шаг добавляет независимое обязательство, которое потребуется выполнить или перечислить в конце. Варьируются
горизонт и энтропия обязательств; измеряются `|Sigma_t|`, omission rate и эмпирический показатель роста cumulative
input.

### Trajectory as target

Аудит, объяснение причины регрессии и восстановление последовательности изменений. Здесь оригинальный SKILL.state
ожидаемо находится вне своей основной области применимости; цель — количественно показать цену полного provenance.

Для всех контролируемых задач нужны горизонты:

```text
T in {10, 25, 50, 100, 200}
```

Environment transitions генерируются детерминированно, а все arms получают парные seeds и одинаковые события.
Обязательный schedule не должен позволять дешёвому раннему завершению выглядеть как экономия.

## Реальные benchmark

Основные кандидаты:

- [LongCLI-Bench](https://aclanthology.org/2026.findings-acl.1497/) — 20 длинных programming/CLI-задач, F2P/P2P и
  step-level progress; инженерный план интеграции уже описан в [LONGCLI-BENCH-PLAN.md](./LONGCLI-BENCH-PLAN.md);
- [LOCA-Bench](https://arxiv.org/abs/2602.07962) — контролируемое увеличение environment description при сохранении
  семантики задачи;
- SWE-bench Verified — опциональная дорогая внешняя проверка после фиксации метода.

InterCode CTF и tau-bench полезны для прямого сопоставления с исходной статьёй, но не должны быть единственными
реальными benchmark: иначе работа останется репликацией на тех же доменах.

## Модели и число повторов

- Использовать не менее трёх модельных семейств и минимум два уровня protocol-following capability.
- Заморозить точные model identifiers/snapshots и reasoning effort.
- На синтетике планировать не менее 20–30 парных seeds на confirmatory condition либо заранее выполнить power analysis.
- На реальных задачах использовать несколько независимых attempts; `n=1` допустим только как pilot.
- Полную сетку выполнять на доступной/open модели, дорогие модели использовать для заранее выбранного confirmatory
  подмножества.

## Метрики

### Primary

- task success under fixed token/sample budget;
- partial progress, если benchmark предоставляет независимый evaluator;
- cumulative logical input с включением неуспешных и timed-out runs;
- Pareto frontier `quality vs cumulative input`.

### Secondary

- cached и uncached input отдельно;
- output и reasoning tokens;
- provider samples и environment actions;
- wall time и provider-reported cost;
- accepted/rejected transitions и recovery retries;
- consecutive identical actions;
- premature finish и timeout rate;
- `|Sigma_t|`, `|U_t|`, observation/retrieval size по шагам;
- omission rate будущих релевантных фактов;
- stale-state actions и recovery lag;
- archive reads, precision и полезность retrieved evidence.

### Growth and crossover

Для каждого runtime оценить эмпирические growth curves cumulative input от `T` и confidence interval для crossover
`T*`. Нельзя заранее навязывать квадратичную/линейную форму, не проверив рост `Sigma_t` и число samples. Показывать
следует одновременно prompt size per step, cumulative tokens и качество.

## Статистический протокол

- Unit of analysis — `task x seed x attempt`, не отдельный model turn.
- Использовать paired comparisons по одинаковым seeds и исходным environment states.
- Для success — paired bootstrap intervals и/или hierarchical logistic model.
- Для token/sample counts — paired bootstrap и модель, учитывающую task/model random effects.
- Сообщать effect sizes и confidence intervals, а не только среднее и процент экономии.
- Timeout, malformed protocol и premature finish остаются исходами arm, а не удаляются из выборки.
- Infrastructure failure отделяется по заранее определённому правилу и перезапускается симметрично для всех arms.
- Primary hypotheses, exclusion rules, budgets и confirmatory arms фиксируются до основного запуска.

## Артефакты воспроизводимости

Для каждой cell сохранять:

- commits runtime, benchmark и harness;
- точный model identifier и inference parameters;
- prompt/tool schema hashes;
- provider-visible requests без секретов;
- полный локальный audit log;
- state patches, observations, acknowledgements и retrievals;
- token accounting и cache semantics;
- evaluator output и причину завершения;
- binary hashes и environment/container identifiers.

Аудит случайной выборки сессий должен подтверждать отсутствие transcript leakage и точное соответствие заявленному
arm. Генераторы синтетических задач, evaluators и analysis scripts публикуются вместе с raw либо безопасно очищенными
trajectories.

## План публикации

### 1. Технический пилот

Подготовить подробный пост для Хабра о реализованных kernel-режимах, фактическом bounded prompt, model dependence,
silent-action loop и влиянии batching. Не утверждать, что SKILL.state «работает только на малом круге задач»; корректный
вывод — bounded prompt сам по себе не гарантирует меньший cumulative cost.

### 2. Короткий анонс

Опубликовать сокращённую версию в LinkedIn со ссылками на Хабр, репозиторий и исходную статью. Цели — внешняя критика,
поиск заинтересованных исследователей и возможных соавторов, а не преждевременное объявление научного результата.

### 3. Protocol freeze

После обсуждения обновить этот документ до versioned `RESEARCH-PROTOCOL`, зафиксировать hypotheses, arms, budgets,
seeds и analysis plan отдельным commit/tag. После freeze изменения оформлять как amendments до просмотра соответствующих
результатов.

### 4. Новые эксперименты и статья

Сначала выполнить controlled diagnostic study, затем confirmatory реальные benchmark. Текущие пилоты вынести в
мотивационный раздел или appendix и явно отделить от новых результатов. После анализа подготовить arXiv preprint и
выбирать workshop/Findings/main track по силе фактического вклада. Перед публичной кампанией проверить актуальную
anonymity policy выбранного venue.

## Минимальный publishable scope

Для короткой empirical paper необходимы как минимум:

1. точная репликация original-paper arm;
2. transcript baseline с идентичными tools/action granularity;
3. независимая абляция observation metadata и `k`;
4. delayed-relevance и state-collision diagnostics;
5. один commit-aware arm;
6. несколько моделей и повторов;
7. один признанный длинный real-world benchmark;
8. открытый protocol, harness и trajectories.

Для более сильной main-track работы дополнительно нужны formal boundary/result для state sufficiency, growing-state
experiment, archive retrieval, два разных реальных домена и убедительное превосходство либо новая regime map, которая
объясняет отрицательные и положительные результаты существующих подходов.

## Что эта работа не должна утверждать заранее

- что `k=3` оптимально;
- что comment всегда помогает;
- что commit-aware state превосходит original SKILL.state;
- что текущие пять greenfield-проектов репрезентативны для long-horizon agents;
- что уменьшение prompt per request гарантирует уменьшение total tokens или latency;
- что `O(T)` выполняется без ограничений на размер `Sigma`, active buffer и retrieval;
- что неуспешный или прерванный дешёвый run является экономией.

Главный ожидаемый результат — не обязательно победа одного runtime. Научную ценность имеет воспроизводимая карта того,
какой объём и тип памяти нужен агенту при разных свойствах задачи и где проходит граница между эффективным state и
опасным забыванием.
