---
name: charts
description: How to choose and draw charts, stat tiles and data tables on a published page, with colour rules and a default palette. Load it when a page shows data.
---

# Showing data

Work through these steps in order. The reference file `palette.md` has the default colours and the list of things to avoid; read it with the skill file tool before choosing colours.

## 1. Pick the form from the data's job

Ask what the reader has to do with the numbers.

- One number that matters: a stat tile with its label, unit and a comparison. Not a chart.
- Change over time: a line (or bars for a few discrete periods).
- Compare categories: horizontal bars, sorted, when labels are long.
- Parts of a whole: a stacked bar or a few labelled bars; use a pie only for two or three parts that clearly add up.
- Relationship between two measures: a scatter plot.
- Distribution: a histogram or a strip of dots.
- Precise lookup: a table.

If a table or a sentence answers the question, use that.

## 2. Assign colour by job

- Categories: one hue per category, in a fixed order, and the same category keeps the same colour everywhere on the page. Never cycle; if you run out, group the rest.
- Sequential (low to high): one hue, light to dark.
- Diverging (below and above a reference): two hues with a neutral midpoint at the reference value.
- Status (good, warning, bad): reserved for status only, and always paired with an icon and a word.
- The page accent is teal, the same as categorical step 1; use it for data only as that first category.

## 3. Draw the marks

- One axis scale per chart. No dual axes.
- Bars start at zero. Lines may not, but say so.
- Gridlines faint, axis lines fainter or absent; leave space around the plot.
- Round values in labels to what the reader can use; include units.
- Draw to scale in SVG or a plotting library from the allowed CDN list at an exact version; derive positions from the data, not by eye.

## 4. Add a hover layer

By default give marks a hover or focus state that shows the exact value and its label. Keep it keyboard-reachable. Do not hide information that is only available on hover when the page may be viewed on a phone: also show the key values as direct labels or in the table view.

## 5. Make it accessible

- With two or more series, include a legend. With four or fewer, also label the series directly on the chart.
- Offer a table view of the same data (a `<details>` with a table is enough).
- Give the chart `role="img"` and an `aria-label` stating the finding.
- Dark mode is chosen, not inverted: use the dark palette steps and check contrast against the dark background.

## 6. Look at it

Preview once when the tool is offered. Check: the finding is the first thing seen, labels do not collide, nothing is clipped at phone width, both themes read.

## Non-negotiables

- One axis per chart.
- Colour follows the entity, not its rank: when a sort order changes, each series keeps its colour.
- No rainbow palettes.
- Text uses text colours, not series colours (a legend label is body text next to a coloured swatch).
- At most about eight series; beyond that, show the top few and group the rest as "Other", or use small multiples (the same small chart repeated, same scale).
- Write the headline as the finding ("Sign-ups doubled after March"), not the topic ("Sign-ups").
