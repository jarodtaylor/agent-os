#!/usr/bin/env python3
"""Copy each diagram's <svg> from docs/site/diagrams/<slug>.html into the site pages.

Why: the diagram files are the editable source (made with the diagram-design skill, full page,
1280px wide). Pages show the same SVG inline so it scales to the page and fonts load once.
A page marks where a diagram goes with:

    <!-- diagram:<slug> --> ...anything... <!-- /diagram:<slug> -->

Ids inside each SVG are prefixed with the slug so two diagrams on one page can't collide
(both define e.g. an "arrow" marker). Re-run after editing any diagram:

    python3 docs/site/sync-diagrams.py
"""
import pathlib, re, sys

SITE = pathlib.Path(__file__).resolve().parent
BLOCK = re.compile(r"(<!-- diagram:([a-z0-9-]+) -->)(.*?)(<!-- /diagram:\2 -->)", re.S)


def svg_for(slug: str) -> str:
    src = (SITE / "diagrams" / f"{slug}.html").read_text()
    m = re.search(r"<svg\b.*?</svg>", src, re.S)
    if not m:
        sys.exit(f"no <svg> in diagrams/{slug}.html")
    svg = m.group(0)
    ids = [i for i in re.findall(r'\bid="([^"]+)"', svg) if not i.startswith(f"{slug}-")]
    for i in ids:
        svg = re.sub(rf'\bid="{re.escape(i)}"', f'id="{slug}-{i}"', svg)
        svg = svg.replace(f"url(#{i})", f"url(#{slug}-{i})").replace(f'href="#{i}"', f'href="#{slug}-{i}"')
    return svg


changed = 0
for page in sorted(SITE.glob("*.html")):
    text = page.read_text()
    new = BLOCK.sub(lambda m: f"{m.group(1)}\n{svg_for(m.group(2))}\n{m.group(4)}", text)
    if new != text:
        page.write_text(new)
        changed += 1
        print(f"updated {page.name}")
print(f"{changed} page(s) changed")
