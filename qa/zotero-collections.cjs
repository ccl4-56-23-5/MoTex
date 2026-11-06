const assert = require('node:assert/strict');
const { collections, search } = require('../desktop/zotero.cjs');
const { collectionTree } = require('../renderer/zotero-collections.mjs');

const rootKey = 'COLLROOT';
const childKey = 'COLLCHLD';
const collection = (key, name, parentCollection = false) => ({ data: { key, name, parentCollection } });
const paper = (key, title, membership = []) => ({
  data: { key, title, itemType: 'journalArticle', date: '2025', collections: membership },
});
const now = Math.floor(Date.now() / 1000);
const recent = Array.from({ length: 32 }, (_, index) => ({
  key: 'R' + String(index).padStart(7, '0'), time: now - index * 60,
}));
const attachment = (parentItem, lastRead) => ({ data: { parentItem, lastRead, itemType: 'attachment' } });
const attachmentRows = [
  ...recent.map(item => attachment(item.key, item.time)),
  attachment(recent[0].key, now - 86400),
  attachment('STALE001', now - 15 * 86400),
  attachment(undefined, now),
];
const parentRows = recent.slice().reverse().map(item => paper(item.key, 'Example article ' + item.key));

async function verify() {
  const originalFetch = global.fetch;
  const calls = [];
  const fixtures = [
    [collection(childKey, 'Nested example', rootKey), collection(rootKey, 'Example')],
    [collection(rootKey, 'Shared example')],
    [paper('PAPER001', 'Collection paper', [childKey])],
    [paper('PAPER002', 'Foreign paper', [])],
    attachmentRows,
    [...parentRows, paper('STALE001', 'Stale read')],
    attachmentRows,
    parentRows,
  ];
  global.fetch = async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:23119');
    assert.equal(options.headers['Zotero-API-Version'], '3');
    calls.push(url);
    assert.ok(fixtures.length, 'Unexpected Zotero request');
    return Response.json(fixtures.shift());
  };
  try {
    const personal = await collections();
    const groups = await collections(21);
    assert.equal(calls[0].pathname, '/api/users/0/collections');
    assert.equal(calls[1].pathname, '/api/groups/21/collections');
    assert.equal(groups[0].parentKey, null);
    assert.equal(collectionTree(personal)[0].children[0].key, childKey);
    const malformed = collectionTree([
      { key: 'CYCLEAAA', name: 'Cycle A', parentKey: 'CYCLEBBB' },
      { key: 'CYCLEBBB', name: 'Cycle B', parentKey: 'CYCLEAAA' },
      { key: 'ORPHANAA', name: 'Orphan', parentKey: 'MISSINGA' },
    ]);
    assert.equal(malformed.length, 2);
    assert.equal(malformed.find(node => node.key === 'CYCLEAAA').children[0].key, 'CYCLEBBB');

    const page = await search(' Alpha & Beta ', 21, 0, 'title', childKey);
    assert.equal(calls[2].pathname, '/api/groups/21/collections/' + childKey + '/items/top');
    assert.equal(calls[2].searchParams.get('q'), 'Alpha & Beta');
    assert.equal(calls[2].searchParams.get('direction'), 'asc');
    assert.equal(page.items[0].id, '21:PAPER001');
    await assert.rejects(search('', null, 0, 'dateModified', childKey), /集合已变更/);
    await assert.rejects(search('', null, 0, 'dateModified', '../items'), /集合编号/);
    await assert.rejects(search('', 21, 0, 'dateModified', 'recent'), /个人文库/);

    const first = await search('Example', null, 0, 'dateModified', 'recent');
    assert.equal(calls[4].searchParams.get('itemType'), 'attachment');
    assert.equal(calls[5].searchParams.get('q'), 'Example');
    assert.deepEqual(calls[5].searchParams.get('itemKey').split(','), recent.map(item => item.key));
    assert.equal(first.nextStart, 30);
    assert.deepEqual(first.items.map(item => item.zoteroKey), recent.slice(0, 30).map(item => item.key));
    const last = await search('Example', null, first.nextStart, 'dateModified', 'recent');
    assert.equal(last.nextStart, null);
    assert.deepEqual(last.items.map(item => item.zoteroKey), recent.slice(30).map(item => item.key));
    assert.equal(calls.length, 8);
  } finally {
    global.fetch = originalFetch;
  }
}

verify().then(() => {
  console.log('PASS Zotero collection hierarchy, scoped paging, and actual reading-timestamp rules');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
