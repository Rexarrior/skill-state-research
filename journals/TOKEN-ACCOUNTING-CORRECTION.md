# Коррекция учёта входных токенов OpenCode

Дата: 2026-09-04. Найдена при подготовке технической статьи.

В текущем исходнике `opencode/packages/opencode/src/session/session.ts`, функция `getUsage`, нормализованный
SDK input раскладывается на три непересекающиеся категории: обычный input, cache read и cache write.
В частности, `tokens.input = max(0, inputTokens - cacheReadInputTokens - cacheWriteInputTokens)`.

Старый benchmark report использовал метрику `input + cache.read`, прямо так её и подписывал. Это не полный
вход: для восстановления общего входа надо добавить cache.write. Сырые данные содержат все три счётчика.

Для двух опубликованных пилотных V3-серий пересчёт выглядит так:

| Runtime/model | Native: полный input | V2: полный input | V3: полный input | V3 к Native: старый показатель → полный input | V3 к V2: полный input |
|---|---:|---:|---:|---:|---:|
| OpenCode/Sol | 1,668,254 | 702,765 | 838,114 | −59.8% → −49.8% | +19.3% |
| OpenCode/Terra | 1,542,615 | 525,667 | 886,744 | −53.2% → −42.5% | +68.7% |

Источники: [Sol](../experiments/skill-state/results/20260904T015621Z/report.md) и
[Terra](../experiments/skill-state/results/20260904T023009Z/report.md), раздел Aggregate counters.

Качество, число обращений и вывод о проигрыше V3 относительно V2 в этих двух агрегатах не меняются. Меняется
величина заявленной экономии полного входа. Исходные отчёты сохраняются с прежним определением метрики для аудита.

В Codex `input_tokens` уже включает cached input. Его повторно не суммируем с cached_input_tokens.
OpenCode также вычитает reasoning из своего output, а Codex сохраняет reasoning как подмножество output_tokens.
В новом сводном отчёте полный output для OpenCode восстанавливается как output + reasoning.

Для новой серии эти правила реализованы в [build-report.ts](../experiments/article-20260904/build-report.ts).
Это коррекция анализа сохранённых usage, не изменение модели или окружения. Ни один исход не исключается
на основании того, стал ли процент экономии привлекательнее после пересчёта.
