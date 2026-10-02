/*
  Lets a content table stack into cards on a phone.

  Starlight renders a markdown table as a horizontally scrolling block, which is the
  right answer for a wide numeric table and the wrong one for the troubleshooting
  pages, whose tables are three columns of prose: on a phone that is reading with one
  eye shut. This plugin writes each header's text onto the cells beneath it as
  `data-label`, and marks the table `data-occ-table`; custom.css then turns every row
  into one card under 48rem with the header as an eyebrow on each cell. Above that
  width nothing changes, and src/markdown/focusable-tables.mjs still makes the scroll
  container reachable from the keyboard.

  A header cell with no text (the comparison tables lead with an empty corner) writes
  no label, and custom.css renders that row's first cell as the card's title.
*/
export function responsiveTables() {
  return {
    name: 'occ-responsive-tables',
    element: {
      filter: ['table'],
      visit(node, ctx) {
        const head = child(node, 'thead');
        const headerRow = head ? child(head, 'tr') : undefined;
        if (!headerRow) return;
        const labels = children(headerRow, 'th').map((cell) => text(cell).replace(/\s+/g, ' ').trim());
        if (labels.every((label) => label === '')) return;

        const body = child(node, 'tbody');
        for (const row of body ? children(body, 'tr') : []) {
          children(row, 'td').forEach((cell, index) => {
            const label = labels[index];
            if (label) ctx.setProperty(cell, 'data-label', label);
          });
        }
        ctx.setProperty(node, 'data-occ-table', '');
      },
    },
  };
}

function child(node, tagName) {
  return (node.children ?? []).find((entry) => entry.type === 'element' && entry.tagName === tagName);
}

function children(node, tagName) {
  return (node.children ?? []).filter((entry) => entry.type === 'element' && entry.tagName === tagName);
}

function text(node) {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(text).join('');
}
