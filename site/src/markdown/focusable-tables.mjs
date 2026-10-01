/*
  Makes a content table reachable from the keyboard.

  Starlight already renders `.sl-markdown-content table` as `display: block;
  overflow: auto`, so a table wider than the content column scrolls instead of being
  clipped. What it cannot do from CSS is make that scroll container focusable, and
  the options reference is wide enough to need it on anything narrower than a laptop.
  `tabindex="0"` on the element that actually scrolls is the standard fix, and it is
  the same treatment the landing page's process panel gets.
*/
export function focusableTables() {
  return {
    name: 'occ-focusable-tables',
    element: {
      filter: ['table'],
      visit(node, ctx) {
        if (node.properties?.tabindex !== undefined) return;
        ctx.setProperty(node, 'tabindex', '0');
      },
    },
  };
}
