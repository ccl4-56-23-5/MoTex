'use strict';

const base = 'http://127.0.0.1:23119';
const itemKey = /^[A-Z0-9]{8}$/;
const safeBibKey = /^[A-Za-z0-9_.:+/-]{1,100}$/;
const nonReferences = new Set(['note', 'attachment', 'annotation']);
const sorts = new Set(['dateModified', 'date', 'title']);
const pageSize = 30;
const recentReadWindow = 14 * 24 * 60 * 60;

async function fetchZotero(endpoint, params, bridge) {
  const url = new URL(endpoint, base);
  url.search = new URLSearchParams(params).toString();
  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: bridge ? { 'X-MoyeLatex-Bridge': '1' } : { 'Zotero-API-Version': '3' }
    });
  } catch {
    throw new Error('无法连接 Zotero，请确认 Zotero 已打开且本地 API 已启用');
  }
  if (!response.ok) {
    if (bridge) throw new Error('无法读取 Zotero 当前选择，请确认已安装并启用墨页插件');
    if (response.status === 403) throw new Error('Zotero 本地 API 未启用');
    throw new Error('Zotero 返回 HTTP ' + response.status);
  }
  return response;
}

async function request(endpoint, params = {}, format = 'json', bridge = false) {
  const response = await fetchZotero(endpoint, params, bridge);
  return format === 'text' ? response.text() : response.json();
}

function scope(groupID) {
  if (groupID == null || groupID === '') return '/api/users/0';
  if (!['string', 'number'].includes(typeof groupID) || !/^[1-9]\d{0,11}$/.test(String(groupID))) {
    throw new Error('Zotero 文库编号无效');
  }
  return '/api/groups/' + groupID;
}

function normalize(row, groupID) {
  const data = row?.data || row;
  if (!data || !itemKey.test(data.key) || nonReferences.has(data.itemType)) return null;
  const authors = (data.creators || []).slice(0, 12).map(person =>
    person.name || [person.firstName, person.lastName].filter(Boolean).join(' ')
  );
  return {
    id: (groupID || 'personal') + ':' + data.key,
    zoteroKey: data.key,
    groupID: groupID || null,
    title: data.title || '无标题',
    author: authors.join('，') || '作者未登记',
    year: String(data.date || '').match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1] || '',
    type: ({ journalArticle: '期刊论文', book: '专著', conferencePaper: '会议论文', thesis: '学位论文',
      report: '报告', preprint: '预印本', bookSection: '图书章节' })[data.itemType] || '文献'
  };
}

async function groups() {
  const data = await request('/api/users/0/groups');
  return data.map(group => ({ id: group.id || group.data?.id, name: group.data?.name || group.name }))
    .filter(group => /^\d{1,12}$/.test(String(group.id)) && typeof group.name === 'string');
}

async function collections(groupID) {
  const rows = await request(scope(groupID) + '/collections');
  if (!Array.isArray(rows)) throw new Error('Zotero 返回了无效的集合数据');
  return rows.flatMap(row => {
    const data = row?.data || row;
    if (typeof data?.key !== 'string' || !itemKey.test(data.key) || typeof data.name !== 'string') return [];
    const parentKey = typeof data.parentCollection === 'string' && itemKey.test(data.parentCollection)
      ? data.parentCollection : null;
    return [{ key: data.key, name: data.name, parentKey }];
  });
}

async function recentRead(query, start, sort) {
  const personal = '/api/users/0/items';
  const attachments = await request(personal, { itemType: 'attachment' });
  if (!Array.isArray(attachments)) throw new Error('Zotero 返回了无效的阅读记录');
  const cutoff = Math.floor(Date.now() / 1000) - recentReadWindow;
  const timestamps = new Map();
  for (const row of attachments) {
    const data = row?.data || row;
    if (data?.itemType !== 'attachment' || typeof data.parentItem !== 'string' || !itemKey.test(data.parentItem)
      || !Number.isSafeInteger(data.lastRead) || data.lastRead <= cutoff) continue;
    timestamps.set(data.parentItem, Math.max(data.lastRead, timestamps.get(data.parentItem) || 0));
  }

  const keys = [...timestamps.keys()];
  const matching = [];
  // The API accepts at most 50 item keys per request. Query the actual parent
  // references so the search uses the same title/creator/year matching as the library.
  for (let index = 0; index < keys.length; index += 50) {
    const batch = keys.slice(index, index + 50);
    const items = await request(personal + '/top', { itemKey: batch.join(','), limit: 50, q: query });
    if (!Array.isArray(items)) throw new Error('Zotero 返回了无效的阅读条目');
    matching.push(...items.map(row => normalize(row, null)).filter(item => item && batch.includes(item.zoteroKey)));
  }
  const lastReadFirst = (a, b) => timestamps.get(b.zoteroKey) - timestamps.get(a.zoteroKey)
    || a.zoteroKey.localeCompare(b.zoteroKey);
  matching.sort(sort === 'title' ? (a, b) => a.title.localeCompare(b.title, 'zh-CN') || lastReadFirst(a, b)
    : sort === 'date' ? (a, b) => Number(b.year) - Number(a.year) || lastReadFirst(a, b) : lastReadFirst);
  return {
    items: matching.slice(start, start + pageSize),
    nextStart: start + pageSize < matching.length ? start + pageSize : null,
  };
}

async function search(query, groupID, start = 0, sort = 'dateModified', collectionKey = null) {
  if (typeof query !== 'string' || query.length > 240) throw new Error('请输入 240 字以内的检索词');
  if (!Number.isSafeInteger(start) || start < 0 || start > Number.MAX_SAFE_INTEGER - pageSize) {
    throw new Error('Zotero 文库页码无效');
  }
  if (!sorts.has(sort)) throw new Error('Zotero 文库排序无效');
  const library = scope(groupID);
  const term = query.trim();
  if (collectionKey === 'recent') {
    if (groupID != null && groupID !== '') throw new Error('最近阅读当前仅支持个人文库');
    return recentRead(term, start, sort);
  }
  if (collectionKey != null && (typeof collectionKey !== 'string' || !itemKey.test(collectionKey))) {
    throw new Error('Zotero 集合编号无效');
  }
  const category = collectionKey == null ? '' : '/collections/' + collectionKey;
  const response = await fetchZotero(library + category + '/items/top', {
    limit: pageSize, start, sort, direction: sort === 'title' ? 'asc' : 'desc', q: term,
  });
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length > pageSize) throw new Error('Zotero 返回了无效的文库分页数据');
  // Offsets describe raw items, including any standalone attachments or notes
  // that aren't displayed as references.
  const offset = start + rows.length;
  const totalHeader = response.headers.get('total-results');
  const total = /^\d+$/.test(totalHeader || '') ? Number(totalHeader) : NaN;
  const hasNext = Number.isSafeInteger(total)
    ? offset < total
    : /\brel="next"/.test(response.headers.get('link') || '') || rows.length === pageSize;
  const items = rows.map(row => {
    const item = normalize(row, groupID);
    const membership = (row?.data || row)?.collections;
    // Some local Zotero versions return the whole library for a deleted key.
    if (item && collectionKey != null && (!Array.isArray(membership) || !membership.includes(collectionKey))) {
      throw new Error('Zotero 集合已变更，请重新打开引用菜单');
    }
    return item;
  }).filter(Boolean);
  return {
    items,
    nextStart: rows.length > 0 && hasNext ? offset : null,
  };
}

async function selection() {
  const data = await request('/moye-latex/v1/selection', {}, 'json', true);
  if (data.protocol !== 1 || !Array.isArray(data.items)) throw new Error('墨页 Zotero 插件协议不匹配');
  const rows = await Promise.all(data.items.slice(0, 50).filter(item => itemKey.test(item.key)).map(async item =>
    normalize(await request(scope(item.groupID) + '/items/' + item.key), item.groupID)
  ));
  return rows.filter(Boolean);
}

// The local translator emits brace-delimited fields. Skip the complete file
// value, including nested braces in attachment names and continuation lines.
function stripAttachmentField(entry) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < entry.length; i++) {
    const char = entry[i];
    if (char === '\\') { i++; continue; }
    if (depth === 1 && char === '\n') {
      const field = /^[ \t]*file[ \t]*=[ \t]*\{/i.exec(entry.slice(i + 1));
      if (field) start = i + 1;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 1 && start !== -1) {
      const tail = /^[ \t]*,?[ \t]*\r?\n?/.exec(entry.slice(i + 1))[0];
      return entry.slice(0, start) + entry.slice(i + 1 + tail.length);
    }
  }
  return entry;
}

async function cite(item, references) {
  if (!item || !itemKey.test(item.zoteroKey) || !Array.isArray(references) || references.length > 2500) {
    throw new Error('引用条目格式无效');
  }
  const endpoint = scope(item.groupID) + '/items/' + item.zoteroKey;
  const current = normalize(await request(endpoint), item.groupID);
  if (!current) throw new Error('请选择可引用的 Zotero 条目');
  const bib = await request(endpoint, { format: 'biblatex' }, 'text');
  const header = /^\s*@([a-z]+)\{([^,\r\n]+),/i.exec(bib);
  if (!header) throw new Error('Zotero 未返回可用的 BibLaTeX 条目');
  const mapped = references.find(reference => reference.id === current.id);
  const occupied = new Set(references.filter(reference => reference.id !== current.id).map(reference => reference.key.toLowerCase()));
  let key = mapped?.key;
  if (!key) {
    const original = header[2].trim();
    const candidate = safeBibKey.test(original) ? original : 'zotero-' + current.zoteroKey;
    key = candidate;
    let serial = 1;
    while (occupied.has(key.toLowerCase())) key = candidate + '-' + serial++;
  }
  const entry = '@' + header[1] + '{' + key + ',' + bib.slice(header[0].length);
  const cleaned = stripAttachmentField(entry).trim();
  return { ...current, key, bib: cleaned };
}

module.exports = { groups, collections, search, selection, cite };
