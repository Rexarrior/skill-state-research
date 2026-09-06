"""Render publication figures from the audited per-cell dataset.

Run: uv run --with matplotlib python experiments/article-20260904/plot.py
"""

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE / "data.json").read_text())
if DATA["missing"]:
    raise SystemExit("Refusing final figures from incomplete data")
ROWS = DATA["rows"]
OUT = HERE.parent.parent / "articles" / "figures"
OUT.mkdir(exist_ok=True)
PROJECTS = ["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"]
LABELS = ["Taskboard", "CSV", "Template", "HTTP KV", "Deps"]
COLORS = {"native": "#59636F", "paper": "#7863A5", "v2": "#167D8D", "v3": "#DD8431"}
MODE_LABELS = {"native": "Native", "paper": "Paper", "v2": "V2", "v3": "V3"}
PANELS = [("OpenCode", "sol"), ("OpenCode", "terra"), ("Codex", "sol"), ("Codex", "terra")]


def main_cells(runtime, model):
    cells = {(r["project"], r["mode"]): r for r in ROWS
             if r["runtime"] == runtime and r["model"] == model and r["repetition"] == 0}
    if len(cells) != 20:
        raise SystemExit(f"Expected 20 main cells for {runtime}/{model}")
    return cells


def unsuccessful(row):
    return not row["artifactPass"] or not row["completed"] or row["protocolFinished"] is False


def save_figure(fig, name):
    for suffix in ["svg", "png"]:
        fig.savefig(OUT / f"{name}.{suffix}", dpi=180, facecolor="white")
    plt.close(fig)
    print(OUT / f"{name}.png")


plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 12, "svg.fonttype": "none"})
fig, axes = plt.subplots(2, 2, figsize=(9.5, 8.5), sharey=True)
all_ratios = [1.0]
for ax, (runtime, model) in zip(axes.flat, PANELS):
    cells = main_cells(runtime, model)
    for j, mode in enumerate(COLORS):
        ratios = [cells[(p, mode)]["input"] / cells[(p, "native")]["input"] for p in PROJECTS]
        if any(ratio <= 0 for ratio in ratios):
            raise SystemExit("Zero-usage outcome requires explicit treatment, not a logarithmic bar")
        all_ratios.extend(ratios)
        bars = ax.bar(np.arange(5) + (j - 1.5) * .19, ratios, width=.18,
                      color=COLORS[mode], label=MODE_LABELS[mode])
        for bar, project, ratio in zip(bars, PROJECTS, ratios):
            row = cells[(project, mode)]
            if unsuccessful(row):
                bar.set_hatch("///")
                ax.annotate("!", (bar.get_x() + bar.get_width() / 2, max(ratio, .08)), ha="center", va="bottom", fontweight="bold")
    ax.axhline(1, color="#333333", linewidth=1, linestyle="--")
    ax.set_title(f"{runtime} / {model.capitalize()}", loc="left", fontweight="bold")
    labels = [label + (" *" if not cells[(p, "native")]["artifactPass"] or not cells[(p, "native")]["completed"] else "")
              for p, label in zip(PROJECTS, LABELS)]
    ax.set_xticks(np.arange(5), labels, rotation=12)
    ax.set_yscale("log", base=2)
    ax.grid(axis="y", alpha=.15)
    ax.set_axisbelow(True)
    ax.spines[["top", "right"]].set_visible(False)
low_power = int(np.floor(np.log2(min(all_ratios) * .8)))
high_power = int(np.ceil(np.log2(max(all_ratios) * 1.25)))
ticks = [2.0 ** power for power in range(low_power, high_power + 1)]
for ax in axes.flat:
    ax.set_ylim(2.0 ** low_power, 2.0 ** high_power)
    ax.set_yticks(ticks, [f"{tick:g}×" for tick in ticks])
fig.suptitle("Cumulative input relative to the native runtime", fontsize=17, x=.06, ha="left", fontweight="bold")
fig.text(.06, .925, "Five tasks · one attempt per cell · input of the main agent loop", color="#555555")
handles, labels = axes[0, 0].get_legend_handles_labels()
fig.legend(handles, labels, loc="lower center", ncol=4, frameon=False, bbox_to_anchor=(.5, .045))
fig.text(.06, .025, "Dashed: Native = 1. Hatched (!): failed checks, timeout, or no finish.", fontsize=10)
fig.text(.06, .005, "Task *: Native failed. Logarithmic y-axis. Lower input is useful only at comparable quality.", fontsize=10)
fig.tight_layout(rect=(.025, .1, .995, .905))
save_figure(fig, "input-by-task")

# Pairwise views use absolute run totals, not normalization or a trajectory over steps.
# All four panels within each figure share a zero-based linear y-axis.
for challenger, reference in [("paper", "native"), ("v2", "native"), ("v3", "native"), ("v3", "v2")]:
    fig, axes = plt.subplots(2, 2, figsize=(9.5, 8.5), sharey=True)
    maximum = 0
    for ax, (runtime, model) in zip(axes.flat, PANELS):
        cells = main_cells(runtime, model)
        for j, mode in enumerate([reference, challenger]):
            values = [cells[(project, mode)]["input"] / 1_000_000 for project in PROJECTS]
            maximum = max(maximum, *values)
            bars = ax.bar(np.arange(5) + (j - .5) * .36, values, width=.33,
                          color=COLORS[mode], label=MODE_LABELS[mode])
            for bar, project, value in zip(bars, PROJECTS, values):
                if unsuccessful(cells[(project, mode)]):
                    bar.set_hatch("///")
                    ax.annotate("!", (bar.get_x() + bar.get_width() / 2, value),
                                xytext=(0, 3), textcoords="offset points", ha="center", va="bottom",
                                fontweight="bold")
        ax.set_title(f"{runtime} / {model.capitalize()}", loc="left", fontweight="bold")
        ax.set_xticks(np.arange(5), LABELS, rotation=12)
        ax.grid(axis="y", alpha=.15)
        ax.set_axisbelow(True)
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(axis="y", labelleft=True)
    for ax in axes.flat:
        ax.set_ylim(0, maximum * 1.16)
        ax.yaxis.set_major_locator(matplotlib.ticker.MaxNLocator(nbins=5))
    for ax in axes[:, 0]:
        ax.set_ylabel("Input, million tokens")
    title = f"{MODE_LABELS[challenger]} vs {MODE_LABELS[reference]}: cumulative input"
    fig.suptitle(title, fontsize=17, x=.06, ha="left", fontweight="bold")
    fig.text(.06, .925, "Five tasks · main attempt only · main agent loop · totals per run", color="#555555")
    handles, labels = axes[0, 0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=2, frameon=False, bbox_to_anchor=(.5, .045))
    fig.text(.06, .025, "Hatched (!): failed checks, timeout, or no finish. Linear y-axis starts at zero.", fontsize=10)
    fig.text(.06, .005, "Same scale in all four panels. Lower input is useful only at comparable quality.", fontsize=10)
    fig.tight_layout(rect=(.025, .1, .995, .905))
    save_figure(fig, f"input-{challenger}-vs-{reference}")
