# Codex / Sol: native и paper, десять повторов

Статус: завершено, 100/100. Новые данные не входят в статью.

Те же настройки, что у V2/V3: medium, 15 минут, до пяти основных CLI. Native использует transcript и Code Mode, paper — исправленный режим статьи. Input включает кэшированный вход; auxiliary отдельно. Обращения — зарегистрированные ответы модели, не действия и не все сетевые попытки.

Завершение native определяется событием turn.completed и чистым выходом, paper — принятым finish и чистым выходом. Полный успех дополнительно требует прохождения всех внешних проверок.

| Повтор | Режим | Задач | Проверки | Input | Обращения | Артефакты прошли | Завершение протокола | Полный успех |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | native | 5/5 | 39/40 | 1,933,670 | 63 | 4/5 | 5/5 | 4/5 |
| 1 | paper | 5/5 | 40/40 | 2,307,093 | 143 | 5/5 | 4/5 | 4/5 |
| 2 | native | 5/5 | 40/40 | 1,932,550 | 63 | 5/5 | 5/5 | 5/5 |
| 2 | paper | 5/5 | 40/40 | 2,148,815 | 133 | 5/5 | 4/5 | 4/5 |
| 3 | native | 5/5 | 39/40 | 1,800,378 | 61 | 4/5 | 5/5 | 4/5 |
| 3 | paper | 5/5 | 40/40 | 2,076,298 | 129 | 5/5 | 4/5 | 4/5 |
| 4 | native | 5/5 | 39/40 | 1,879,196 | 62 | 4/5 | 5/5 | 4/5 |
| 4 | paper | 5/5 | 39/40 | 2,642,086 | 165 | 4/5 | 4/5 | 3/5 |
| 5 | native | 5/5 | 40/40 | 2,167,098 | 67 | 5/5 | 5/5 | 5/5 |
| 5 | paper | 5/5 | 39/40 | 2,904,115 | 182 | 4/5 | 4/5 | 3/5 |
| 6 | native | 5/5 | 40/40 | 2,238,863 | 68 | 5/5 | 5/5 | 5/5 |
| 6 | paper | 5/5 | 40/40 | 3,326,013 | 206 | 5/5 | 3/5 | 3/5 |
| 7 | native | 5/5 | 39/40 | 2,014,289 | 64 | 4/5 | 5/5 | 4/5 |
| 7 | paper | 5/5 | 39/40 | 6,837,664 | 420 | 4/5 | 0/5 | 0/5 |
| 8 | native | 5/5 | 40/40 | 1,947,012 | 63 | 5/5 | 5/5 | 5/5 |
| 8 | paper | 5/5 | 31/40 | 2,788,874 | 175 | 4/5 | 4/5 | 4/5 |
| 9 | native | 5/5 | 40/40 | 1,516,461 | 57 | 5/5 | 5/5 | 5/5 |
| 9 | paper | 5/5 | 40/40 | 2,992,921 | 185 | 5/5 | 3/5 | 3/5 |
| 10 | native | 5/5 | 40/40 | 2,058,016 | 64 | 5/5 | 5/5 | 5/5 |
| 10 | paper | 5/5 | 37/40 | 4,294,795 | 267 | 2/5 | 2/5 | 1/5 |

## Первичные исходы

| Повтор | Режим | Проект | Проверки | Input | Обращения | Таймаут | Завершение протокола |
|---|---|---|---:|---:|---:|---|---|
| 1 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010725Z/baseline/taskboard-cli/summary.json) | 8/8 | 363,822 | 11 | false | true |
| 1 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T010725Z/baseline/csv-insights/summary.json) | 7/8 | 412,200 | 13 | false | true |
| 1 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T010725Z/baseline/mini-template/summary.json) | 8/8 | 245,561 | 11 | false | true |
| 1 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T010725Z/baseline/http-kv/summary.json) | 9/9 | 464,839 | 14 | false | true |
| 1 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010725Z/baseline/dependency-planner/summary.json) | 7/7 | 447,248 | 14 | false | true |
| 1 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010725Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 405,470 | 25 | false | true |
| 1 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T010725Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 281,764 | 18 | false | true |
| 1 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T010725Z/skill-state-paper/mini-template/summary.json) | 8/8 | 300,770 | 19 | false | true |
| 1 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T010725Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,209,104 | 74 | true | false |
| 1 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010725Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 109,985 | 7 | false | true |
| 2 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010737Z/baseline/taskboard-cli/summary.json) | 8/8 | 147,812 | 7 | false | true |
| 2 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T010737Z/baseline/csv-insights/summary.json) | 8/8 | 436,942 | 13 | false | true |
| 2 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T010737Z/baseline/mini-template/summary.json) | 8/8 | 377,547 | 15 | false | true |
| 2 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T010737Z/baseline/http-kv/summary.json) | 9/9 | 699,907 | 19 | false | true |
| 2 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010737Z/baseline/dependency-planner/summary.json) | 7/7 | 270,342 | 9 | false | true |
| 2 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010737Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 107,855 | 7 | false | true |
| 2 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T010737Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 567,045 | 35 | false | true |
| 2 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T010737Z/skill-state-paper/mini-template/summary.json) | 8/8 | 174,200 | 11 | false | true |
| 2 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T010737Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,015,524 | 62 | true | false |
| 2 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010737Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 284,191 | 18 | false | true |
| 3 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010746Z/baseline/taskboard-cli/summary.json) | 7/8 | 291,128 | 10 | false | true |
| 3 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T010746Z/baseline/csv-insights/summary.json) | 8/8 | 227,583 | 10 | false | true |
| 3 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T010746Z/baseline/mini-template/summary.json) | 8/8 | 359,362 | 15 | false | true |
| 3 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T010746Z/baseline/http-kv/summary.json) | 9/9 | 173,706 | 7 | false | true |
| 3 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010746Z/baseline/dependency-planner/summary.json) | 7/7 | 748,599 | 19 | false | true |
| 3 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010746Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 286,905 | 18 | false | true |
| 3 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T010746Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 139,017 | 9 | false | true |
| 3 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T010746Z/skill-state-paper/mini-template/summary.json) | 8/8 | 184,698 | 12 | false | true |
| 3 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T010746Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,292,369 | 79 | true | false |
| 3 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010746Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 173,309 | 11 | false | true |
| 4 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010756Z/baseline/taskboard-cli/summary.json) | 7/8 | 263,534 | 9 | false | true |
| 4 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T010756Z/baseline/csv-insights/summary.json) | 8/8 | 657,669 | 18 | false | true |
| 4 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T010756Z/baseline/mini-template/summary.json) | 8/8 | 241,723 | 11 | false | true |
| 4 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T010756Z/baseline/http-kv/summary.json) | 9/9 | 494,680 | 14 | false | true |
| 4 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010756Z/baseline/dependency-planner/summary.json) | 7/7 | 221,590 | 10 | false | true |
| 4 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010756Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 233,125 | 15 | false | true |
| 4 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T010756Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 403,203 | 25 | false | true |
| 4 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T010756Z/skill-state-paper/mini-template/summary.json) | 7/8 | 172,363 | 11 | false | true |
| 4 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T010756Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,273,407 | 78 | true | false |
| 4 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010756Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 559,988 | 36 | false | true |
| 5 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010805Z/baseline/taskboard-cli/summary.json) | 8/8 | 360,322 | 12 | false | true |
| 5 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T010805Z/baseline/csv-insights/summary.json) | 8/8 | 236,008 | 9 | false | true |
| 5 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T010805Z/baseline/mini-template/summary.json) | 8/8 | 613,566 | 18 | false | true |
| 5 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T010805Z/baseline/http-kv/summary.json) | 9/9 | 471,894 | 13 | false | true |
| 5 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010805Z/baseline/dependency-planner/summary.json) | 7/7 | 485,308 | 15 | false | true |
| 5 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T010805Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 937,570 | 57 | false | true |
| 5 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T010805Z/skill-state-paper/csv-insights/summary.json) | 7/8 | 358,027 | 23 | false | true |
| 5 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T010805Z/skill-state-paper/mini-template/summary.json) | 8/8 | 989,389 | 63 | true | false |
| 5 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T010805Z/skill-state-paper/http-kv/summary.json) | 9/9 | 189,315 | 12 | false | true |
| 5 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T010805Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 429,814 | 27 | false | true |
| 6 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T015507Z/baseline/taskboard-cli/summary.json) | 8/8 | 420,661 | 14 | false | true |
| 6 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T015507Z/baseline/csv-insights/summary.json) | 8/8 | 408,360 | 12 | false | true |
| 6 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T015507Z/baseline/mini-template/summary.json) | 8/8 | 430,326 | 14 | false | true |
| 6 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T015507Z/baseline/http-kv/summary.json) | 9/9 | 505,791 | 14 | false | true |
| 6 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T015507Z/baseline/dependency-planner/summary.json) | 7/7 | 473,725 | 14 | false | true |
| 6 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T015507Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 1,034,914 | 63 | true | false |
| 6 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T015507Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 107,509 | 7 | false | true |
| 6 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T015507Z/skill-state-paper/mini-template/summary.json) | 8/8 | 369,917 | 24 | false | true |
| 6 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T015507Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,575,197 | 97 | true | false |
| 6 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T015507Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 238,476 | 15 | false | true |
| 7 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T020250Z/baseline/taskboard-cli/summary.json) | 7/8 | 177,242 | 8 | false | true |
| 7 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T020250Z/baseline/csv-insights/summary.json) | 8/8 | 272,487 | 11 | false | true |
| 7 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T020250Z/baseline/mini-template/summary.json) | 8/8 | 342,137 | 14 | false | true |
| 7 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T020250Z/baseline/http-kv/summary.json) | 9/9 | 546,965 | 14 | false | true |
| 7 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T020250Z/baseline/dependency-planner/summary.json) | 7/7 | 675,458 | 17 | false | true |
| 7 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T020250Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 1,449,532 | 88 | true | false |
| 7 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T020250Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 1,608,030 | 99 | true | false |
| 7 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T020250Z/skill-state-paper/mini-template/summary.json) | 8/8 | 972,031 | 62 | true | false |
| 7 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T020250Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,372,821 | 84 | true | false |
| 7 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T020250Z/skill-state-paper/dependency-planner/summary.json) | 6/7 | 1,435,250 | 87 | true | false |
| 8 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T020321Z/baseline/taskboard-cli/summary.json) | 8/8 | 255,474 | 11 | false | true |
| 8 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T020321Z/baseline/csv-insights/summary.json) | 8/8 | 155,076 | 7 | false | true |
| 8 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T020321Z/baseline/mini-template/summary.json) | 8/8 | 457,206 | 14 | false | true |
| 8 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T020321Z/baseline/http-kv/summary.json) | 9/9 | 779,317 | 18 | false | true |
| 8 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T020321Z/baseline/dependency-planner/summary.json) | 7/7 | 299,939 | 13 | false | true |
| 8 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T020321Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 554,944 | 34 | false | true |
| 8 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T020321Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 563,737 | 35 | false | true |
| 8 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T020321Z/skill-state-paper/mini-template/summary.json) | 8/8 | 575,507 | 37 | false | true |
| 8 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T020321Z/skill-state-paper/http-kv/summary.json) | 0/9 | 508,731 | 33 | true | false |
| 8 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T020321Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 585,955 | 36 | false | true |
| 9 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T020613Z/baseline/taskboard-cli/summary.json) | 8/8 | 303,282 | 11 | false | true |
| 9 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T020613Z/baseline/csv-insights/summary.json) | 8/8 | 490,168 | 15 | false | true |
| 9 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T020613Z/baseline/mini-template/summary.json) | 8/8 | 242,911 | 11 | false | true |
| 9 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T020613Z/baseline/http-kv/summary.json) | 9/9 | 224,570 | 9 | false | true |
| 9 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T020613Z/baseline/dependency-planner/summary.json) | 7/7 | 255,530 | 11 | false | true |
| 9 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T020613Z/skill-state-paper/taskboard-cli/summary.json) | 8/8 | 252,914 | 16 | false | true |
| 9 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T020613Z/skill-state-paper/csv-insights/summary.json) | 8/8 | 1,193,821 | 73 | true | false |
| 9 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T020613Z/skill-state-paper/mini-template/summary.json) | 8/8 | 138,819 | 9 | false | true |
| 9 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T020613Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,059,279 | 65 | true | false |
| 9 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T020613Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 348,088 | 22 | false | true |
| 10 | native | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T021023Z/baseline/taskboard-cli/summary.json) | 8/8 | 245,997 | 9 | false | true |
| 10 | native | [csv-insights](../../experiments/codex-skill-state/results/20260906T021023Z/baseline/csv-insights/summary.json) | 8/8 | 256,365 | 10 | false | true |
| 10 | native | [mini-template](../../experiments/codex-skill-state/results/20260906T021023Z/baseline/mini-template/summary.json) | 8/8 | 503,098 | 15 | false | true |
| 10 | native | [http-kv](../../experiments/codex-skill-state/results/20260906T021023Z/baseline/http-kv/summary.json) | 9/9 | 583,214 | 16 | false | true |
| 10 | native | [dependency-planner](../../experiments/codex-skill-state/results/20260906T021023Z/baseline/dependency-planner/summary.json) | 7/7 | 469,342 | 14 | false | true |
| 10 | paper | [taskboard-cli](../../experiments/codex-skill-state/results/20260906T021023Z/skill-state-paper/taskboard-cli/summary.json) | 7/8 | 369,096 | 24 | false | true |
| 10 | paper | [csv-insights](../../experiments/codex-skill-state/results/20260906T021023Z/skill-state-paper/csv-insights/summary.json) | 7/8 | 1,286,080 | 79 | true | false |
| 10 | paper | [mini-template](../../experiments/codex-skill-state/results/20260906T021023Z/skill-state-paper/mini-template/summary.json) | 7/8 | 1,312,563 | 82 | true | false |
| 10 | paper | [http-kv](../../experiments/codex-skill-state/results/20260906T021023Z/skill-state-paper/http-kv/summary.json) | 9/9 | 1,157,190 | 71 | true | false |
| 10 | paper | [dependency-planner](../../experiments/codex-skill-state/results/20260906T021023Z/skill-state-paper/dependency-planner/summary.json) | 7/7 | 169,866 | 11 | false | true |

[План до запуска](./PROTOCOL.md). Четырёхсторонняя сводка с прежними V2/V3 формируется отдельно в COMPARE-FOUR.md. Исходный оценщик не изменён; дополнительный тест удаления CLI показывается отдельно.
