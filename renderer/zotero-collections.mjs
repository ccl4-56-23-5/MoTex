export function collectionTree(rows) {
  const byKey = new Map();
  for (const row of rows) if (!byKey.has(row.key)) byKey.set(row.key, row);
  const children = new Map();
  const roots = [];
  const compare = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.key.localeCompare(b.key);
  for (const row of byKey.values()) {
    if (row.parentKey === row.key || !byKey.has(row.parentKey)) {
      roots.push(row);
      continue;
    }
    if (!children.has(row.parentKey)) children.set(row.parentKey, []);
    children.get(row.parentKey).push(row);
  }
  const visited = new Set();
  function visit(row) {
    if (visited.has(row.key)) return null;
    visited.add(row.key);
    return { ...row, children: (children.get(row.key) || []).sort(compare).map(visit).filter(Boolean) };
  }
  const tree = roots.sort(compare).map(visit);
  // Keep orphaned cycles navigable instead of recursing forever or hiding them.
  for (const row of [...byKey.values()].sort(compare)) if (!visited.has(row.key)) tree.push(visit(row));
  return tree;
}

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export function mountZoteroCollections({ source, sort, fetchCollections, onSelect, onLayout }) {
  const section = document.createElement('section');
  section.className = 'zotero-collections';
  section.setAttribute('aria-label', 'Zotero 文献集合');
  section.hidden = true;
  source.parentElement.after(section);
  const recentOrder = sort.querySelector('option[value="dateModified"]');
  const regularOrder = recentOrder.textContent;
  let key = null;
  let ticket = 0;

  function select(value, notify = true) {
    const changed = key !== value;
    key = value;
    recentOrder.textContent = key === 'recent' ? '最近阅读时间' : regularOrder;
    for (const button of section.querySelectorAll('[data-collection-key]')) {
      button.setAttribute('aria-pressed', String(button.dataset.collectionKey === (key ?? '')));
    }
    if (changed && notify) onSelect();
  }

  function item(value, title, symbol, childRows = []) {
    const node = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'zotero-collection-row';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'zotero-collection-button';
    action.dataset.collectionKey = value ?? '';
    action.setAttribute('aria-pressed', String(value === key));
    action.title = title;
    const label = document.createElement('span');
    label.textContent = title;
    action.append(icon(symbol), label);
    action.addEventListener('click', () => select(value));

    const disclosure = document.createElement(childRows.length ? 'button' : 'span');
    disclosure.className = 'zotero-collection-disclosure';
    row.append(disclosure, action);
    node.append(row);
    if (childRows.length) {
      disclosure.type = 'button';
      disclosure.setAttribute('aria-label', '展开 ' + title);
      disclosure.setAttribute('aria-expanded', 'false');
      disclosure.append(icon('down'));
      const branch = document.createElement('ul');
      branch.className = 'zotero-collection-children';
      branch.hidden = true;
      branch.append(...childRows.map(child => item(child.key, child.name, 'folder', child.children)));
      node.append(branch);
      disclosure.addEventListener('click', () => {
        const expanded = branch.hidden;
        branch.hidden = !expanded;
        disclosure.setAttribute('aria-label', (expanded ? '折叠 ' : '展开 ') + title);
        disclosure.setAttribute('aria-expanded', String(expanded));
        onLayout();
      });
    }
    return node;
  }

  function render(personal, rows, status) {
    const list = document.createElement('ul');
    list.className = 'zotero-collection-list';
    list.append(item(null, '全部文献', 'book'));
    if (personal) list.append(item('recent', '最近阅读', 'clock'));
    for (const node of collectionTree(rows)) list.append(item(node.key, node.name, 'folder', node.children));
    section.replaceChildren(list);
    if (status) {
      const message = document.createElement('p');
      message.className = 'zotero-collection-status';
      message.setAttribute('role', 'status');
      message.textContent = status;
      section.append(message);
    }
    onLayout();
  }

  function close() {
    ticket++;
    select(null, false);
    section.hidden = true;
    section.replaceChildren();
  }

  async function reset() {
    close();
    const request = ticket;
    const personal = source.value === 'all';
    if (!personal && !/^[1-9]\d{0,11}$/.test(source.value)) {
      onLayout();
      return;
    }
    const groupID = personal ? null : source.value;
    section.hidden = false;
    render(personal, [], '正在读取 Zotero 集合…');
    try {
      const rows = await fetchCollections(groupID);
      if (request === ticket) render(personal, rows, '');
    } catch (error) {
      if (request === ticket) render(personal, [], error.message);
    }
  }

  return { reset, close, get key() { return key; } };
}
