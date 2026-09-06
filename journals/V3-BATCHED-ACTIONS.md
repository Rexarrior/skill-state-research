# V3: неограниченные последовательные батчи действий

Уточнения аудита 2026-09-05: это исторический пилот, не новая серия для статьи. Старые OpenCode prompt totals
не включают cache.write ([пересчёт](./TOKEN-ACCOUNTING-CORRECTION.md)); clean ниже означает exit/timeout,
а не обязательный `finish` — старый Codex/Sol V2 taskboard завершился обычным текстом.
Предпроверка V3 также не означает проверку всех параметров вложенных tools до первого действия
([границы реализации](../experiments/PAPER-CONFORMANCE.md)). Исправленные условия и новые прогоны собраны
[отдельно](../experiments/article-20260904/README.md).

V3 проверяет гипотезу, что главный overhead v2 на коротких codegen-задачах связан не только с prompt, но и с жёстким
правилом «одно действие на provider turn». Модель теперь возвращает `state_patch + comment? + actions[]`; массив не
имеет ограничения по числу элементов. Ядро валидирует весь переход, один раз применяет patch и выполняет действия
строго последовательно. Ошибка останавливает батч, оставшиеся действия получают `skipped`. В окне `k=3` целый массив
с результатами занимает один слот наблюдения.

Точный контракт и команды: [описание v3](../experiments/V3-BATCHED-ACTIONS.md).

## Результаты

| Runtime / модель | Baseline | V2 | V3 | Токены B / V2 / V3 | Multi-batches / max |
|---|---:|---:|---:|---:|---:|
| OpenCode / Sol | 40/40 | 40/40 | 40/40 | 1,515,899 / 532,003 / 609,763 prompt | 19 / 5 |
| OpenCode / Terra | 38/40 | 40/40 | 39/40 | 1,401,206 / 380,139 / 655,543 prompt | 22 / 7 |
| Codex / Sol | 40/40 | 40/40 | 40/40 | 1,582,573 / 990,678 / 818,113 input | 16 / 6 |
| Codex / Terra | 40/40 | 40/40 | 39/40 | 1,907,750 / 1,171,999 / 1,867,198 input | 13 / 5 |

V3 выиграл у v2 только в Codex/Sol: `-17.4%` input и 44 samples вместо 57 при одинаковых 40/40. В OpenCode обе модели
чаще дробили работу, поэтому v3 оказался дороже v2, хотя оставался заметно дешевле baseline. Codex/Terra почти не
использовал batching: 118 действий легли в 102 наблюдения, и экономия против baseline сократилась до 2.1% при потере
одной проверки.

Постулат об отсутствии лимита пока не опровергнут: максимальный фактический массив имел 5–7 действий. Модели не
злоупотребляли размером. Ограничивающим фактором оказалась политика выбора батча, а не schema capacity.

## Валидность запусков

- Во всех OpenCode suites было 15/15 zero-exit cells без timeout.
- Codex/Sol suite `20260904T023020Z` — 15/15 clean; baseline действительно использовал Code Mode.
- Первый Codex/Sol запуск отброшен: после `cargo clean` отсутствовал `codex-code-mode-host`, и baseline молча перешёл на
  direct tools. Harness теперь проверяет companion и пишет его SHA-256.
- Одноклеточные Codex-диагностики до основных suites (`20260904T014327Z`, `20260904T015342Z`,
  `20260904T022644Z`) сохранены для аудита, но не входят в агрегаты.
- Codex/Terra потерял сеть после десяти чистых cells (`No route to host`). Пять повреждённых cells повторены свежими
  процессами и workspace; composite `20260904T114822Z` содержит 15 уникальных clean cells и ссылки на оба источника.
- Каждый cell — `n=1`. Разница между v2/v3 может быть меньше модельной variance; нужны повторы.

Подробные отчёты:

- [OpenCode v3, Sol и Terra](../experiments/skill-state/REPORT-v3-sol-terra-k3.md)
- [Codex v3, Sol и Terra](../experiments/codex-skill-state/REPORT-v3-sol-terra-k3.md)
- [сырой OpenCode/Sol suite](../experiments/skill-state/results/20260904T015621Z/report.md)
- [сырой OpenCode/Terra suite](../experiments/skill-state/results/20260904T023009Z/report.md)
- [сырой Codex/Sol suite](../experiments/codex-skill-state/results/20260904T023020Z/report.md)
- [Codex/Terra composite](../experiments/codex-skill-state/results/20260904T114822Z/report.md)
