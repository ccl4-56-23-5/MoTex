import { imagePattern } from './formula-structure.mjs';

export function withoutAttachment(text, id) {
  return text.split('\n').filter(line => line.trim().match(imagePattern)?.[2] !== id).join('\n');
}

export function renderAttachments({ text, chapters, assets, onDelete }) {
  const host = document.querySelector('#assets');
  const count = document.querySelector('#asset-count');
  const groups = new Map();
  const placed = new Set();
  let chapterIndex = -1;
  let offset = 0;

  function add(chapter, asset, caption) {
    const key = chapter?.no ?? 0;
    if (!groups.has(key)) groups.set(key, { chapter, images: new Map() });
    groups.get(key).images.set(asset.id, { asset, caption });
  }

  for (const line of text.split('\n')) {
    while (chapters[chapterIndex + 1]?.start <= offset) chapterIndex++;
    const marker = line.trim().match(imagePattern);
    if (marker && assets.has(marker[2])) {
      const asset = assets.get(marker[2]);
      add(chapters[chapterIndex], asset, marker[1]);
      placed.add(asset.id);
    }
    offset += line.length + 1;
  }
  for (const asset of assets.values()) {
    if (!placed.has(asset.id)) add(null, asset, '');
  }

  count.textContent = assets.size;
  const items = document.createDocumentFragment();
  for (const { chapter, images } of groups.values()) {
    const section = document.createElement('section');
    section.className = 'attachment-chapter';
    const title = document.createElement('h3');
    title.textContent = chapter
      ? '第 ' + chapter.no + ' 章' + (chapter.title ? ' · ' + chapter.title : '')
      : '未归入章节';
    section.append(title);
    const cards = document.createElement('div');
    cards.className = 'attachment-cards';

    for (const { asset, caption } of images.values()) {
      const card = document.createElement('div');
      card.className = 'attachment-card';
      const thumb = document.createElement('img');
      thumb.src = asset.data;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      const label = document.createElement('span');
      label.className = 'attachment-name';
      label.textContent = caption || asset.name;
      label.title = label.textContent;
      const remove = document.createElement('button');
      remove.className = 'attachment-remove';
      remove.type = 'button';
      remove.title = '删除附件';
      remove.setAttribute('aria-label', '删除附件 ' + label.textContent);
      remove.innerHTML = '<svg aria-hidden="true"><use href="#i-trash"/></svg>';
      remove.addEventListener('click', () => void onDelete(asset.id));
      card.append(thumb, label, remove);
      cards.append(card);
    }
    section.append(cards);
    items.append(section);
  }

  if (!groups.size) {
    const empty = document.createElement('p');
    empty.className = 'attachment-empty';
    empty.textContent = '暂无图片';
    items.append(empty);
  }
  host.replaceChildren(items);
}
