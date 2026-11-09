---
name: diagrams
description: How to draw a diagram on a published page as inline SVG that shows how something works. Load it when a page needs a diagram.
---

# Drawing a diagram

Use a diagram when a picture explains faster than prose: a flow, a structure, a comparison, a timeline. If the reader would be just as well served by a sentence or a table, write that instead.

## What to draw

- Draw the mechanism, not its name. A box labelled "Cache" tells the reader nothing; show what goes in, what comes out, and what decides between them.
- To compare options, draw the difference between them, side by side on the same scale, not two separate pictures that must be compared in the head.
- Match the complexity to the decision. A diagram for a yes/no choice has a handful of shapes; do not draw the whole system to make one point.
- Label arrows with what happens along them ("sends token", "retries after 2s"), not with nothing.
- One diagram makes one claim. If it makes two, draw two.

## Mermaid is not available

The page frame does not render Mermaid. Draw with inline SVG.

## Building the SVG

- Size by `viewBox` and let CSS scale it: `svg { max-width: 100%; height: auto; }`. Do not set fixed pixel width and height.
- Work on a grid (multiples of 8 or 10) so edges line up and spacing is even.
- Strokes and text use `currentColor`, so they follow the theme. Use one literal hue for the element that matters most, chosen to read on both light and dark backgrounds, and keep the rest neutral.
- Fills for shapes that need them can be a custom property from the page's tokens, or a translucent `currentColor` (`fill="currentColor" fill-opacity="0.08"`).
- Arrowheads are `<marker>` definitions in `<defs>` or small `<polygon>`s.
- Text is 11 to 13px at the rendered size; check that the viewBox does not shrink it below that on a phone. If it would, make the diagram taller instead of wider, or let it scroll in its own `overflow-x: auto` wrapper with a `min-width`.
- Keep labels short; break long ones across `<tspan>` lines.
- Nothing inside the SVG but shapes and text: no `<script>`, no `<style>`, no `<foreignObject>`.

## Wrapping it

```html
<figure>
  <svg
    viewBox="0 0 480 160"
    role="img"
    aria-label="Request goes from client to cache, then to the origin on a miss"
  >
    <!-- shapes, arrows, labels -->
  </svg>
  <figcaption>A miss costs one extra hop to the origin; a hit never leaves the cache.</figcaption>
</figure>
```

- The `<figcaption>` states the claim the diagram supports, as a sentence.
- `role="img"` and an `aria-label` describe what the picture shows for someone who cannot see it.
- Colour never carries meaning alone: pair it with a label, shape or line style.

## Check before publishing

- Does every arrow have a start, an end and a reason?
- Is the one important element visibly the one that matters?
- Does it still read at phone width and in both themes?
- Could a sentence have done the job?
