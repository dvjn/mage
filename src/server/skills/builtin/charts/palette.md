# Default chart palette and what to avoid

Replace these with the user's brand colours if they gave any. Use them as tokens on `:root`, with the dark values under the same theme rules as the rest of the page.

## Categorical, in this fixed order

| Step | Name       | Light     | Dark      |
| ---- | ---------- | --------- | --------- |
| 1    | Teal       | `#0e7c86` | `#4cc3cc` |
| 2    | Indigo     | `#4a3fc8` | `#8c95f0` |
| 3    | Amber      | `#bd7e10` | `#e8b04b` |
| 4    | Rose       | `#c2456b` | `#ec7fa0` |
| 5    | Olive      | `#779a2a` | `#a3c45a` |
| 6    | Steel blue | `#3d6f99` | `#7fa8cc` |
| 7    | Coral      | `#d0643e` | `#f0926e` |
| 8    | Plum       | `#8a4f9e` | `#bd8ad0` |

Step 1 is the page accent of the house style. Assign by entity once and keep it. Slate for "Other": `#8a93a0` light, `#6f7885` dark.

## Sequential (one hue, five steps)

Teal. Light theme, light to dark: `#d3ecee`, `#8fd0d5`, `#45a9b2`, `#0e7c86`, `#0a4f57`.
Dark theme, so that more is brighter: `#12353a`, `#17606a`, `#2a9099`, `#4cc3cc`, `#a6e6ea`.

## Diverging

Negative side coral `#d0643e` (dark `#f0926e`), slate midpoint `#e1e5eb` (dark `#262c36`), positive side teal `#0e7c86` (dark `#4cc3cc`). The midpoint is the reference value, not the data's centre.

## Status (always with icon and word)

| Status  | Light     | Dark      |
| ------- | --------- | --------- |
| Good    | `#1f8a5b` | `#4cc98f` |
| Warning | `#b7791f` | `#e8b04b` |
| Bad     | `#c2452d` | `#f07a62` |

Do not reuse these hues for categories on the same page.

## Chart text and structure

- Chart surface: the page background, `#fbfcfd` light and `#0f1217` dark.
- Axis and tick text: the muted text token, 11 to 12px.
- Gridlines: the text token at 10 to 15 percent opacity.
- Mark outlines on dark backgrounds: the surface colour, 1px, to separate touching marks.
- Aim for at least 3:1 contrast between a mark and its background, 4.5:1 for text.

## Mistakes to avoid

- Dual axes that make two unrelated lines appear correlated.
- Truncated bar axes.
- Pie charts with more than three slices, or with slices that are not parts of a whole.
- 3D, shadows and gradients on marks.
- Rainbow or cycling colours; colours reassigned when the data is re-sorted.
- Colour as the only difference between series (add labels, line styles or markers).
- Status colours used to mean categories, or categories that happen to look like status colours.
- Series-coloured text for labels and values.
- A legend that must be matched to marks by eye when direct labels would fit.
- More than about eight series on one chart.
- Charts that need hover to be understood.
- Decorative charts that show no real data.
- Dark mode made by inverting light colours.
- Sparse data drawn as a smooth curve that implies values between the points.
