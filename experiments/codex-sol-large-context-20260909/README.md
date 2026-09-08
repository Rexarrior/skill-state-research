# Sol / SKILL.state с лимитами 2 MiB

Отдельная серия на той же сборке, что завершённая Astra с большими лимитами.
Меняется модель на gpt-5.6-sol; четыре режима, по пять повторов пяти задач,
до пяти основных CLI одновременно. Новые независимые сессии, не повтор
выбранных неудач.

- [Протокол](PROTOCOL.md).
- [Проверки перед запуском](preflight.json).
- [Замороженные входы](source-manifest.json), [текущее состояние](run.json).
- [Переиспользуемая сборка Astra](../codex-astra-large-context-20260908/build-manifest.json).
- [Patch ядра](../codex-astra-large-context-20260908/kernel.patch).
- После завершения — restoration.json и isolation-watch.json.

Бинарник находится в .private/source завершённой серии Astra. Не пересобирать
и не удалять его во время новой серии. Raw logs и рабочие результаты Sol —
в собственном игнорируемом .private/results.

Первый запуск после проверок:

```sh
bun experiments/codex-sol-large-context-20260909/run.ts --with-global-instructions
```

Статус без вывода промптов:

```sh
bun experiments/codex-sol-large-context-20260909/progress.ts
```

Повторный запуск поверх существующих run.json/source-manifest запрещён.
Глобальные источники возвращаются после остановки всех воркеров.
После жёсткого прерывания использовать точный ledger из .private/isolation.json,
предварительно убедившись, что воркеры остановлены. Резервные копии не удалять.

Это эксперимент, не изменение статьи. Предыдущие результаты сохраняются.
