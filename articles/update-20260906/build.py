"""Static editorial figures; read frozen campaigns, never rerun or overwrite them.

uv run --offline --with matplotlib python articles/update-20260906/build.py
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
OUT = ROOT / "articles/figures"
SOURCES = ["experiments/article-20260904/data.json",
           "experiments/codex-sol-controls-20260906/combined-data.json"]
primary, repeated = [json.loads((ROOT / file).read_text()) for file in SOURCES]
assert not primary["missing"] and len(primary["rows"]) == 120
assert not repeated["missing"] and len(repeated["rows"]) == 200
assert len({r["threadID"] for r in repeated["rows"]}) == 200
PROJECTS = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
LABELS = ["Taskboard", "CSV", "Template", "HTTP KV", "Deps"]
PANELS = [("OpenCode", "sol"), ("OpenCode", "terra"), ("Codex", "sol"), ("Codex", "terra")]
COLORS = {"native": "#59636F", "paper": "#7863A5", "v2": "#167D8D", "v3": "#DD8431"}
NAMES = {"native": "Native", "paper": "Paper", "v2": "V2", "v3": "V3"}
figures = []
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 12, "svg.fonttype": "none"})


def save(fig, name):
    for suffix in ("png", "svg"):
        fig.savefig(OUT / f"{name}.{suffix}", dpi=180, facecolor="white")
    plt.close(fig)
    figures.append(name)
    print(name)


def unsuccessful(row):
    return not row["artifactPass"] or not row["completed"] or row["protocolFinished"] is False


for challenger, reference in [("paper", "native"), ("v2", "native"), ("v3", "native"), ("v3", "v2"), (None, None)]:
    modes = [reference, challenger] if challenger else list(COLORS)
    fig, axes = plt.subplots(4, 2, figsize=(11.8, 12), sharey="col")
    maxima = [0, 0]
    ratios = []
    for row_index, (runtime, model) in enumerate(PANELS):
        cells = {(r["project"], r["mode"]): r for r in primary["rows"]
                 if r["runtime"] == runtime and r["model"] == model and r["repetition"] == 0}
        assert len(cells) == 20
        for col, (key, divisor, ylabel) in enumerate([
            ("input", 1_000_000, "Input, million tokens"), ("calls", 1, "Model calls per task")
        ]):
            ax = axes[row_index, col]
            width = .8 / len(modes)
            for j, mode in enumerate(modes):
                values = [cells[(p, mode)][key] / divisor for p in PROJECTS]
                if not challenger and col == 0:
                    values = [cells[(p, mode)]["input"] / cells[(p, "native")]["input"] for p in PROJECTS]
                    assert min(values) > 0
                    ratios.extend(values)
                maxima[col] = max(maxima[col], *values)
                bars = ax.bar(np.arange(5) + (j - (len(modes) - 1) / 2) * width, values,
                              width=width * .9, color=COLORS[mode], label=NAMES[mode])
                for bar, p, value in zip(bars, PROJECTS, values):
                    if unsuccessful(cells[(p, mode)]):
                        bar.set_hatch("///")
                        ax.annotate("!", (bar.get_x() + bar.get_width() / 2, value),
                                    xytext=(0, 2), textcoords="offset points", ha="center", fontweight="bold")
            ax.set_title(f"{runtime} / {model.capitalize()}", loc="left", fontweight="bold", fontsize=12)
            ax.set_ylabel(ylabel)
            ax.set_xticks(np.arange(5), LABELS)
            ax.grid(axis="y", alpha=.16)
            ax.set_axisbelow(True)
            ax.spines[["top", "right"]].set_visible(False)
            ax.tick_params(axis="y", labelleft=True)
            ax.yaxis.set_major_locator(matplotlib.ticker.MaxNLocator(nbins=4, integer=col == 1))
            if not challenger and col == 0:
                ax.set_ylabel("Input relative to Native")
                ax.set_yscale("log", base=2)
                ax.axhline(1, color="#333333", linewidth=1, linestyle="--")
    for col in range(2):
        for ax in axes[:, col]:
            if not challenger and col == 0:
                lower = int(np.floor(np.log2(min(ratios) * .8)))
                upper = int(np.ceil(np.log2(max(ratios) * 1.25)))
                ticks = [2.0 ** power for power in range(lower, upper + 1)]
                ax.set_ylim(ticks[0], ticks[-1])
                ax.set_yticks(ticks, [f"{tick:g}×" for tick in ticks])
                continue
            ax.set_ylim(0, maxima[col] * 1.16)
    title = f"{NAMES[challenger]} vs {NAMES[reference]}" if challenger else "All four modes"
    fig.suptitle(f"{title}: input and agent cycles", x=.08, ha="left", fontsize=18, fontweight="bold")
    fig.text(.08, .946, "Five tasks · original main attempt · main agent loop only", color="#555555")
    fig.legend(*axes[0, 0].get_legend_handles_labels(), loc="lower center", ncol=len(modes),
               frameon=False, bbox_to_anchor=(.5, .029))
    fig.text(.08, .02, "Hatched (!): failed original checks, timeout, or no finish. All outcomes retained.", fontsize=10)
    fig.text(.08, .005, "Shared scale within each column. Calls count recorded model responses, not tool actions or elapsed time.", fontsize=10)
    fig.tight_layout(rect=(.025, .065, .995, .936), h_pad=1.4, w_pad=2)
    save(fig, f"input-cycles-{challenger}-vs-{reference}" if challenger else "input-cycles-all-modes")

# One point is one complete repeat averaged over the same five projects, NOT a
# new task or a matched seed. Timeout durations stay at the observed cutoff.
fig, axes = plt.subplots(1, 3, figsize=(13, 4.9))
repeat_values = []
for j, mode in enumerate(COLORS):
    subset = [r for r in repeated["rows"] if r["mode"] == mode]
    assert len(subset) == 50
    points = []
    for rep in range(1, 11):
        cells = [r for r in subset if r["repetition"] == rep]
        assert len(cells) == 5 and {r["project"] for r in cells} == set(PROJECTS)
        points.append({"repetition": rep, "mode": mode,
                       "inputPerTask": sum(r["input"] for r in cells) / 5,
                       "callsPerTask": sum(r["calls"] for r in cells) / 5,
                       "minutesPerTask": sum(r["durationMs"] for r in cells) / 5 / 60000,
                       "timeouts": sum(r["timedOut"] for r in cells)})
    repeat_values.extend(points)
    for ax, key, divisor in zip(axes, ["inputPerTask", "callsPerTask", "minutesPerTask"], [1_000_000, 1, 1]):
        values = np.array([p[key] / divisor for p in points])
        # Fixed offsets only for readability; their order does not encode time.
        for offset, point, value in zip(np.linspace(-.16, .16, 10), points, values):
            ax.scatter(j + offset, value, color=COLORS[mode], s=40,
                       marker="^" if point["timeouts"] else "o", alpha=.8)
        ax.plot([j - .27, j + .27], [values.mean()] * 2, color=COLORS[mode], linewidth=3)
for ax, title, ylabel in zip(axes, ["Input per task", "Agent cycles per task", "Observed time per task"],
                             ["Million input tokens", "Recorded model calls", "Minutes, including waits"]):
    ax.set_title(title, loc="left", fontweight="bold", fontsize=13)
    ax.set_ylabel(ylabel)
    ax.set_xticks(range(4), [NAMES[m] for m in COLORS])
    ax.set_xlim(-.55, 3.55)
    ax.set_ylim(bottom=0)
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="y", alpha=.16)
    ax.set_axisbelow(True)
fig.suptitle("Codex / Sol: ten repeats of five tasks per mode", x=.06, ha="left", fontsize=17, fontweight="bold")
fig.text(.06, .035, "Each point: one repeat averaged over five tasks. Thick line: mean of ten repeats. Triangle: repeat includes a timeout.", fontsize=10)
fig.text(.06, .005, "V2/V3 ran earlier; Native/Paper later. All outcomes retained; 15-minute task limit. Calls are not a direct clock.", fontsize=10)
fig.tight_layout(rect=(.015, .085, .995, .90), w_pad=2)
save(fig, "codex-sol-ten-repeats-input-cycles-time")

manifest = {"sources": {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in SOURCES},
            "figures": figures, "repeatValues": repeat_values,
            "primaryCells": 120, "additionalCells": 200,
            "policy": "Frozen inputs read-only. No model calls. Figure point values retained for QA."}
(HERE / "figure-data.json").write_text(json.dumps(manifest, indent=2) + "\n")
