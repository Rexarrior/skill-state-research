# Codex / Sol — 10 повторов V2 и V3

Статус: завершено, 100/100 задач. Отдельная серия для внутреннего анализа; не входит в статью.

Условия: k=3, medium reasoning, 15 минут на задачу, до пяти основных CLI одновременно. Input включает кэшированный вход основной модели; вспомогательные вызовы считаются отдельно. Обращения — зарегистрированные ответы модели, не действия батча и не все сетевые попытки. Это не денежная стоимость. Неудачные исходы сохранены.

## Полные попытки

| Попытка | V2 проверки | V2 input | V2 обращения | V2 успех | V3 проверки | V3 input | V3 обращения | V3 успех | V3/V2 input |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 40/40 | 873,982 | 50 | 5/5 | 40/40 | 1,242,029 | 65 | 5/5 | +42.1% |
| 2 | 40/40 | 907,242 | 52 | 5/5 | 40/40 | 1,098,641 | 60 | 5/5 | +21.1% |
| 3 | 40/40 | 799,487 | 46 | 5/5 | 40/40 | 1,496,599 | 79 | 5/5 | +87.2% |
| 4 | 39/40 | 742,748 | 43 | 4/5 | 39/40 | 901,770 | 49 | 4/5 | +21.4% |
| 5 | 40/40 | 1,254,538 | 69 | 5/5 | 40/40 | 1,584,507 | 83 | 5/5 | +26.3% |
| 6 | 40/40 | 896,417 | 52 | 5/5 | 40/40 | 1,686,196 | 88 | 5/5 | +88.1% |
| 7 | 39/40 | 1,271,468 | 71 | 4/5 | 40/40 | 1,420,084 | 76 | 5/5 | +11.7% |
| 8 | 39/40 | 1,315,103 | 73 | 4/5 | 40/40 | 909,644 | 48 | 5/5 | -30.8% |
| 9 | 39/40 | 742,593 | 43 | 4/5 | 40/40 | 1,162,693 | 61 | 5/5 | +56.6% |
| 10 | 40/40 | 991,060 | 57 | 5/5 | 39/40 | 1,566,447 | 82 | 3/5 | +58.1% |

Успех = все внешние проверки пройдены, процесс завершился без ошибки/таймаута и принят finish.

## Распределения

| Режим | Задач | Проверки | Успех | Finish | Таймауты | Input всего | Обращения всего | Медиана input полной попытки | Q25–Q75 | Min–Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v2 | 50 | 396/400 | 46/50 | 50/50 | 0 | 9,794,638 | 556 | 901,830 | 818,111–1,188,669 | 742,593–1,315,103 |
| v3 | 50 | 398/400 | 47/50 | 49/50 | 1 | 13,068,610 | 691 | 1,331,057 | 1,114,654–1,548,985 | 901,770–1,686,196 |

Квантили вычислены линейной интерполяцией по упорядоченной выборке; интервалы здесь описательные, не доверительные.

## По задачам

| Проект | Режим | Успех | Проверки | Input: среднее | Медиана | Min–Max | Обращения: медиана | Min–Max |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| taskboard-cli | v2 | 8/10 | 78/80 | 162,588 | 154,633 | 102,635–257,322 | 9 | 6–14 |
| taskboard-cli | v3 | 10/10 | 80/80 | 233,163 | 181,365 | 103,082–553,413 | 9.5 | 6–29 |
| csv-insights | v2 | 10/10 | 80/80 | 160,657 | 141,554 | 80,300–349,632 | 8 | 5–19 |
| csv-insights | v3 | 9/10 | 79/80 | 221,462 | 187,982 | 142,685–435,872 | 10 | 8–22 |
| mini-template | v2 | 8/10 | 78/80 | 200,936 | 201,374 | 134,431–268,227 | 11.5 | 8–16 |
| mini-template | v3 | 9/10 | 79/80 | 216,484 | 222,693 | 144,077–296,871 | 12 | 8–15 |
| http-kv | v2 | 10/10 | 90/90 | 278,018 | 226,748 | 156,589–665,302 | 12.5 | 9–36 |
| http-kv | v3 | 9/10 | 90/90 | 395,995 | 280,948 | 192,190–899,653 | 15 | 10–46 |
| dependency-planner | v2 | 10/10 | 70/70 | 177,265 | 143,210 | 100,110–369,614 | 8 | 6–20 |
| dependency-planner | v3 | 10/10 | 70/70 | 239,757 | 235,083 | 120,161–427,512 | 13 | 6–22 |

## Использование батчей V3

Принятых непустых батчей: 689; отклонённых с пустым массивом результатов: 0. Действий в записанных батчах: 1133, из них не пропущено: 1005. Среднее число записанных действий на принятый батч: 1.64. Максимум: 7. Принятых батчей с ошибкой действия: 263.

В это число входят finish и ошибочные действия; непустой батч не обязательно успешен. Непропущенный вызов инструмента не гарантирует завершение запущенного ОС-процесса. Число обращений к модели не подменяется числом принятых батчей.

## Парные сравнения и ограничения

В 10 полных парных попытках V3 использовала +33.4% основного input к V2; меньше входа в 1/10 попыток. Медиана относительной разницы: +34.2%.

Разложение накопленного входа на число обращений и средний вход одного обращения: V2 — 556 × 17,616; V3 — 691 × 18,913 (средние в тексте округлены). Обращений у V3 +24.3%, среднего input на обращение +7.4%. Это арифметическое разложение измеренного расхода, не причинная оценка влияния batching.

Пар отдельных задач: 50; обе версии полностью успешны в 43. Среди только этих успешных пар меньше input у V3 в 10, равенство в 0. Это условный срез, не замена общей оценки качества.

Десять попыток повторяют пять известных задач, а не расширяют выборку до пятидесяти независимых задач. Порядок чередуется, но не рандомизирован. Время и конкурентность отличаются от прошлой серии; результаты не объединяются с ней. V2/V3 меняют и количество действий между запросами, и объём окна; причинные выводы о batching отдельно невозможны.

## Чувствительность качества к избыточному требованию оценщика

После начала серии обнаружено, что проверка delete требует поле id в JSON-ответе, хотя спецификация его не задаёт. Дополнительная проверка фактического удаления выполнена на 20/20 изолированных копий CLI-проектов обеих версий. Исходные баллы выше не изменены. Ниже — отдельный ретроспективный срез, заменяющий только эту проверку там, где её избыточность подтверждена; остальные проверки не переоцениваются. [Подробности](./EVALUATOR-NOTE.md), [данные перепроверки](./taskboard-delete-audit.json).

| Режим | Исходные проверки | С заменой только проверки delete | Исходный успех задач | Успех в этом срезе |
|---|---:|---:|---:|---:|
| v2 | 396/400 | 398/400 | 46/50 | 48/50 |
| v3 | 398/400 | 398/400 | 47/50 | 47/50 |

Этот срез не является новым заранее зарегистрированным benchmark и не даёт права считать все прочие тесты исчерпывающей проверкой спецификации. Input, обращения, завершение и исходные summaries не меняются.

## Исходные серии

- Попытка 1, порядок v2 → v3, статус complete: [20260905T232335Z](../codex-skill-state/results/20260905T232335Z/report.md).
- Попытка 2, порядок v3 → v2, статус complete: [20260905T232344Z](../codex-skill-state/results/20260905T232344Z/report.md).
- Попытка 3, порядок v2 → v3, статус complete: [20260905T232353Z](../codex-skill-state/results/20260905T232353Z/report.md).
- Попытка 4, порядок v3 → v2, статус complete: [20260905T232401Z](../codex-skill-state/results/20260905T232401Z/report.md).
- Попытка 5, порядок v2 → v3, статус complete: [20260905T232410Z](../codex-skill-state/results/20260905T232410Z/report.md).
- Попытка 6, порядок v3 → v2, статус complete: [20260905T235756Z](../codex-skill-state/results/20260905T235756Z/report.md).
- Попытка 7, порядок v2 → v3, статус complete: [20260905T235928Z](../codex-skill-state/results/20260905T235928Z/report.md).
- Попытка 8, порядок v3 → v2, статус complete: [20260906T000243Z](../codex-skill-state/results/20260906T000243Z/report.md).
- Попытка 9, порядок v2 → v3, статус complete: [20260906T000251Z](../codex-skill-state/results/20260906T000251Z/report.md).
- Попытка 10, порядок v3 → v2, статус complete: [20260906T001510Z](../codex-skill-state/results/20260906T001510Z/report.md).

## Отдельные исходы

| Попытка | Проект | Режим | Проверки | Input | Обращения | Таймаут | Finish |
|---|---|---|---:|---:|---:|---|---|
| 1 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 130,602 | 8 | false | true |
| 1 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 236,871 | 13 | false | true |
| 1 | [mini-template](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 166,771 | 10 | false | true |
| 1 | [http-kv](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 177,074 | 10 | false | true |
| 1 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 162,664 | 9 | false | true |
| 1 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 371,211 | 18 | false | true |
| 1 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 170,395 | 9 | false | true |
| 1 | [mini-template](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 278,128 | 15 | false | true |
| 1 | [http-kv](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 192,190 | 10 | false | true |
| 1 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232335Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 230,105 | 13 | false | true |
| 2 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 139,930 | 8 | false | true |
| 2 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 143,045 | 8 | false | true |
| 2 | [mini-template](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 247,863 | 14 | false | true |
| 2 | [http-kv](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 259,302 | 15 | false | true |
| 2 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 117,102 | 7 | false | true |
| 2 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 309,162 | 17 | false | true |
| 2 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 226,989 | 13 | false | true |
| 2 | [mini-template](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 144,077 | 8 | false | true |
| 2 | [http-kv](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 286,676 | 15 | false | true |
| 2 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232344Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 131,737 | 7 | false | true |
| 3 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 117,815 | 7 | false | true |
| 3 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 122,591 | 7 | false | true |
| 3 | [mini-template](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 239,215 | 14 | false | true |
| 3 | [http-kv](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 196,110 | 11 | false | true |
| 3 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 123,756 | 7 | false | true |
| 3 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 191,868 | 10 | false | true |
| 3 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 435,872 | 22 | false | true |
| 3 | [mini-template](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 255,428 | 14 | false | true |
| 3 | [http-kv](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 391,669 | 21 | false | true |
| 3 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232353Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 221,762 | 12 | false | true |
| 4 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 182,848 | 11 | false | true |
| 4 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 82,193 | 5 | false | true |
| 4 | [mini-template](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state/mini-template/summary.json) | v2 | 7/8 | 156,925 | 9 | false | true |
| 4 | [http-kv](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 156,589 | 9 | false | true |
| 4 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 164,193 | 9 | false | true |
| 4 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 123,919 | 7 | false | true |
| 4 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state-v3/csv-insights/summary.json) | v3 | 7/8 | 142,685 | 8 | false | true |
| 4 | [mini-template](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 165,042 | 9 | false | true |
| 4 | [http-kv](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 230,063 | 12 | false | true |
| 4 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232401Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 240,061 | 13 | false | true |
| 5 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 257,322 | 14 | false | true |
| 5 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 160,537 | 9 | false | true |
| 5 | [mini-template](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 209,679 | 12 | false | true |
| 5 | [http-kv](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 257,386 | 14 | false | true |
| 5 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 369,614 | 20 | false | true |
| 5 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 263,964 | 14 | false | true |
| 5 | [csv-insights](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 223,857 | 12 | false | true |
| 5 | [mini-template](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 224,870 | 12 | false | true |
| 5 | [http-kv](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 444,304 | 23 | false | true |
| 5 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T232410Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 427,512 | 22 | false | true |
| 6 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 150,686 | 9 | false | true |
| 6 | [csv-insights](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 80,300 | 5 | false | true |
| 6 | [mini-template](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 245,168 | 14 | false | true |
| 6 | [http-kv](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 194,547 | 11 | false | true |
| 6 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 225,716 | 13 | false | true |
| 6 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 103,082 | 6 | false | true |
| 6 | [csv-insights](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 295,646 | 15 | false | true |
| 6 | [mini-template](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 220,515 | 12 | false | true |
| 6 | [http-kv](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 778,705 | 40 | false | true |
| 6 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T235756Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 288,248 | 15 | false | true |
| 7 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 158,882 | 9 | false | true |
| 7 | [csv-insights](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 140,063 | 8 | false | true |
| 7 | [mini-template](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state/mini-template/summary.json) | v2 | 7/8 | 193,068 | 11 | false | true |
| 7 | [http-kv](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 665,302 | 36 | false | true |
| 7 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 114,153 | 7 | false | true |
| 7 | [taskboard-cli](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 553,413 | 29 | false | true |
| 7 | [csv-insights](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 179,681 | 10 | false | true |
| 7 | [mini-template](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 233,750 | 12 | false | true |
| 7 | [http-kv](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 202,011 | 11 | false | true |
| 7 | [dependency-planner](../../experiments/codex-skill-state/results/20260905T235928Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 251,229 | 14 | false | true |
| 8 | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state/taskboard-cli/summary.json) | v2 | 7/8 | 158,580 | 9 | false | true |
| 8 | [csv-insights](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 349,632 | 19 | false | true |
| 8 | [mini-template](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 148,015 | 9 | false | true |
| 8 | [http-kv](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 385,343 | 21 | false | true |
| 8 | [dependency-planner](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 273,533 | 15 | false | true |
| 8 | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 170,861 | 9 | false | true |
| 8 | [csv-insights](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 171,854 | 9 | false | true |
| 8 | [mini-template](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 171,548 | 9 | false | true |
| 8 | [http-kv](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 275,220 | 15 | false | true |
| 8 | [dependency-planner](../../experiments/codex-skill-state/results/20260906T000243Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 120,161 | 6 | false | true |
| 9 | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state/taskboard-cli/summary.json) | v2 | 7/8 | 226,579 | 13 | false | true |
| 9 | [csv-insights](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 80,463 | 5 | false | true |
| 9 | [mini-template](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 134,431 | 8 | false | true |
| 9 | [http-kv](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 179,314 | 10 | false | true |
| 9 | [dependency-planner](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 121,806 | 7 | false | true |
| 9 | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 106,153 | 6 | false | true |
| 9 | [csv-insights](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 171,361 | 9 | false | true |
| 9 | [mini-template](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state-v3/mini-template/summary.json) | v3 | 8/8 | 296,871 | 15 | false | true |
| 9 | [http-kv](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 259,457 | 14 | false | true |
| 9 | [dependency-planner](../../experiments/codex-skill-state/results/20260906T000251Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 328,851 | 17 | false | true |
| 10 | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state/taskboard-cli/summary.json) | v2 | 8/8 | 102,635 | 6 | false | true |
| 10 | [csv-insights](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state/csv-insights/summary.json) | v2 | 8/8 | 210,875 | 12 | false | true |
| 10 | [mini-template](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state/mini-template/summary.json) | v2 | 8/8 | 268,227 | 16 | false | true |
| 10 | [http-kv](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state/http-kv/summary.json) | v2 | 9/9 | 309,213 | 17 | false | true |
| 10 | [dependency-planner](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state/dependency-planner/summary.json) | v2 | 7/7 | 100,110 | 6 | false | true |
| 10 | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state-v3/taskboard-cli/summary.json) | v3 | 8/8 | 138,001 | 8 | false | true |
| 10 | [csv-insights](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state-v3/csv-insights/summary.json) | v3 | 8/8 | 196,282 | 10 | false | true |
| 10 | [mini-template](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state-v3/mini-template/summary.json) | v3 | 7/8 | 174,606 | 9 | false | true |
| 10 | [http-kv](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state-v3/http-kv/summary.json) | v3 | 9/9 | 899,653 | 46 | true | false |
| 10 | [dependency-planner](../../experiments/codex-skill-state/results/20260906T001510Z/skill-state-v3/dependency-planner/summary.json) | v3 | 7/7 | 157,905 | 9 | false | true |
