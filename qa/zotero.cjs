const assert = require('node:assert/strict');
const { groups, search } = require('../desktop/zotero.cjs');

const item = (key, itemType = 'journalArticle') => ({ data: { key, itemType, title: 'Example paper' } });
const attachments = Array.from({ length: 30 }, (_, index) => item('A' + String(index).padStart(7, '0'), 'attachment'));
const paper = item('PAPER001');
const responses = [
  Response.json(attachments, { headers: { 'Total-Results': '32' } }),
  Response.json([paper, item('NOTE0001', 'note')], { headers: { 'Total-Results': '32' } }),
  Response.json([paper], { headers: { Link: '<http://127.0.0.1:23119/api/groups/21/items/top?start=1>; rel="next"' } }),
  Response.json([], { headers: { 'Total-Results': '0' } }),
  Response.json([{ id: 21, data: { name: 'Research group' } }]),
  Response.json({ data: [] }),
];
const calls = [];

async function verify() {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:23119');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Zotero-API-Version'], '3');
    calls.push(url);
    assert.ok(responses.length, 'Unexpected Zotero request');
    return responses.shift();
  };
  try {
    const first = await search('', null);
    assert.deepEqual(first, { items: [], nextStart: 30 }, 'Filtering must not lose the next page.');
    const next = await search('', null, first.nextStart);
    assert.equal(next.items[0].id, 'personal:PAPER001');
    assert.equal(next.items.length, 1);
    assert.equal(next.nextStart, null);
    assert.equal(calls[1].pathname, '/api/users/0/items/top');
    assert.equal(calls[1].searchParams.get('start'), '30');
    assert.equal(calls[1].searchParams.get('limit'), '30');
    assert.equal(calls[1].searchParams.get('direction'), 'desc');

    const group = await search('  Beam & timing  ', 21, 0, 'title');
    assert.equal(group.items[0].id, '21:PAPER001');
    assert.equal(group.items[0].groupID, 21);
    assert.equal(group.nextStart, 1, 'Use the raw row count when only the next link is available.');
    assert.equal(calls[2].pathname, '/api/groups/21/items/top');
    assert.equal(calls[2].searchParams.get('q'), 'Beam & timing');
    assert.equal(calls[2].searchParams.get('sort'), 'title');
    assert.equal(calls[2].searchParams.get('direction'), 'asc');
    assert.deepEqual(await search('', 21, group.nextStart, 'date'), { items: [], nextStart: null });
    assert.equal(calls[3].searchParams.get('sort'), 'date');
    assert.equal(calls[3].searchParams.get('direction'), 'desc');

    assert.deepEqual(await groups(), [{ id: 21, name: 'Research group' }]);
    assert.equal(calls[4].pathname, '/api/users/0/groups');
    assert.equal(calls[4].searchParams.has('limit'), false);
    await assert.rejects(search('', null), /分页数据/);

    await assert.rejects(search(null, null), /检索词/);
    await assert.rejects(search('A'.repeat(241), null), /检索词/);
    await assert.rejects(search('', '../../api'), /文库编号/);
    await assert.rejects(search('', { toString: () => '21' }), /文库编号/);
    await assert.rejects(search('', null, '30'), /页码/);
    await assert.rejects(search('', null, -1), /页码/);
    await assert.rejects(search('', null, 0, 'creator'), /排序/);
    assert.equal(calls.length, 6, 'Invalid arguments must be rejected before sending a request.');
  } finally {
    global.fetch = originalFetch;
  }
}

verify().then(() => {
  console.log('PASS Zotero raw offsets, empty pages, sorting, group scopes, and invalid inputs');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
