# Codex / Sol: дополнение native и paper

По десять полных повторов пяти задач на каждый режим: 100 новых запусков. Вместе с предыдущими V2/V3 —
200 исходов на четырёх вариантах. До пяти основных CLI одновременно; это отдельная серия, не обновление статьи.

Серия завершена: 100/100 новых запусков, 200/200 в объединении. [Выводы и интерпретация](./RESULTS.md).

- [План до запуска](./PROTOCOL.md), [состояние runner](./run.json), [хеши исходников и защищённых данных](./source-manifest.json).
- [Новые результаты native/paper](./REPORT.md), [сравнение всех четырёх вариантов](./COMPARE-FOUR.md), [данные сводки](./combined-data.json).
- [Предыдущие V2/V3](../codex-sol-repeats-20260906/RESULTS.md) остаются неизменными.
- [Повторное чтение и обрезка наблюдений](./READING-LOOP-NOTE.md): отдельный разбор случая paper, не изменение оценок.

Настройки одинаковы, но native/paper проводились
позже V2/V3: это не одновременно рандомизированные четыре ветки. Исходные оценки и поправка к тесту delete
показываются отдельно. Неудачные попытки сохраняются без автоматических перепрогонов.

## Сбор без новых вызовов модели

```sh
bun experiments/codex-sol-controls-20260906/analyze.ts
bun experiments/codex-sol-controls-20260906/archive-workspaces.ts
bun experiments/codex-sol-controls-20260906/audit-taskboard-delete.ts
bun experiments/codex-sol-controls-20260906/audit-traces.ts
bun experiments/codex-sol-controls-20260906/action-errors.ts
bun experiments/codex-sol-controls-20260906/host-context-audit.ts
bun experiments/codex-sol-controls-20260906/auxiliary-usage.ts
bun experiments/codex-sol-controls-20260906/scan-artifacts.ts
bun experiments/codex-sol-controls-20260906/compare.ts
bun experiments/codex-sol-controls-20260906/context-comparison.ts
bun experiments/codex-sol-controls-20260906/truncation-audit.ts
```

Для финальной пересборки: analyze.ts --final, перечисленные сборщики, затем verify.ts. Финальная проверка требует 100 новых исходов,
проверяет usage, архивы, предыдущую серию, исходники, статью и лимит runner. run.ts завершился; повторный
запуск означал бы новую серию и здесь не нужен. Native завершается штатным terminal event, paper — через finish.

Аудиты сохраняют только хеши стартового профиля и счётчики связанных вспомогательных сессий;
публичная публикация сырых журналов не входит в задачу. Input включает кэшированный вход и не равен стоимости.
