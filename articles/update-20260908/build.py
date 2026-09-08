"""Two new static figures only; historical figures and sources stay unchanged.

uv run --offline --with matplotlib python articles/update-20260908/build.py
"""
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SOURCE = "experiments/codex-clean-comparison-20260908/statistics.json"
data = json.loads((ROOT / SOURCE).read_text())
COLORS = {"native": "#59636F", "paper": "#7863A5", "v2": "#167D8D", "v3": "#DD8431"}
NAMES = {"native": "Native", "paper": "Paper", "v2": "V2", "v3": "V3"}
PANELS = [
    ("inputPerTask", 1e6, "Input на задачу", "Миллионы входных токенов", 3),
    ("callsPerTask", 1, "Циклы на задачу", "Зарегистрированные ответы модели", 2),
    ("minutesPerTask", 1, "Время на задачу", "Минуты, включая ожидания", 2),
]
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "svg.fonttype": "none", "svg.hashsalt": "clean-codex-20260908"})
figures = []
for cohort, label in [("sol", "Sol"), ("astra", "Astra")]:
    fig, axes = plt.subplots(1, 3, figsize=(13.7, 5.4))
    for j, mode in enumerate(COLORS):
        points = [p for p in data["repeats"] if p["cohort"] == cohort and p["mode"] == mode]
        assert len(points) == 5 and {p["repetition"] for p in points} == set(range(1, 6))
        for ax, (key, divisor, title, ylabel, decimals) in zip(axes, PANELS):
            values = [p[key] / divisor for p in points]
            for offset, point, value in zip(np.linspace(-.16, .16, 5), points, values):
                ax.scatter(j + offset, value, color=COLORS[mode], s=52,
                           marker="^" if point["timeouts"] else "o", alpha=.85, zorder=3)
            mean = sum(values) / 5
            ax.plot([j - .25, j + .25], [mean] * 2, color=COLORS[mode], linewidth=3, zorder=4)
            ax.annotate(f"{mean:.{decimals}f}".replace(".", ","), (j, max(values)),
                        xytext=(0, 10), textcoords="offset points", ha="center", fontsize=10)
    for ax, (key, divisor, title, ylabel, _) in zip(axes, PANELS):
        ax.set_title(title, loc="left", fontweight="bold", fontsize=13)
        ax.set_ylabel(ylabel)
        ax.set_xticks(range(4), [NAMES[m] for m in COLORS])
        ax.set_xlim(-.55, 3.55)
        # The corresponding panels deliberately use identical scales for both models.
        ax.set_ylim(0, max(p[key] / divisor for p in data["repeats"]) * 1.21)
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", alpha=.16)
        ax.set_axisbelow(True)
    fig.suptitle(f"Codex / {label}: пять повторов без глобальных скиллов",
                 x=.06, ha="left", fontsize=17, fontweight="bold")
    fig.text(.06, .89, "25 сессий на режим · основной агентный цикл · все исходы, включая таймауты", color="#555555", fontsize=11)
    fig.text(.06, .068, "Точка — среднее пяти задач одного повтора. Черта и число — среднее всех пяти повторов.", fontsize=10)
    fig.text(.06, .033, "Треугольник — в повторе был таймаут (лимит 15 минут). Шкалы одинаковы у Sol и Astra; время включает ожидания.", fontsize=10)
    fig.tight_layout(rect=(.015, .12, .995, .88), w_pad=2)
    name = f"codex-{cohort}-clean-five-repeats-input-cycles-time"
    hashes = {}
    for suffix in ("png", "svg"):
        target = ROOT / "articles/figures" / f"{name}.{suffix}"
        fig.savefig(target, dpi=180, facecolor="white", metadata={"Date": None} if suffix == "svg" else {})
        if suffix == "svg":
            target.write_text("\n".join(line.rstrip() for line in target.read_text().splitlines()) + "\n")
        hashes[str(target.relative_to(ROOT))] = hashlib.sha256(target.read_bytes()).hexdigest()
    plt.close(fig)
    figures.append({"cohort": cohort, "name": name, "hashes": hashes})
    print(name)
(HERE / "figure-data.json").write_text(json.dumps({
    "sources": {SOURCE: hashlib.sha256((ROOT / SOURCE).read_bytes()).hexdigest()},
    "figures": figures, "points": data["repeats"],
    "policy": "Only two new figures. No model calls; old figures not regenerated. All outcomes and common cross-model panel scales."
}, indent=2) + "\n")
