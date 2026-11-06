export const chapterPattern = /^:::chapter[ \t]+(\S.*)$/;
export const headingPattern = /^(#{1,6})\s+(.*)$/;
export const imagePattern = /^!\[([^\]]*)\]\(asset:([A-Za-z0-9_-]+)\)$/;

export function readDisplayMath(lines, start, skipPlaceholder = false) {
  const chunks = [];
  let end = start + (skipPlaceholder ? 1 : 0);
  let fragment = lines[start].trim().slice(2);
  while (!fragment.includes('$$')) {
    chunks.push(fragment);
    end += 1;
    if (end === lines.length) throw new Error('第 ' + (start + 1) + ' 行的独立公式缺少结束的 $$。');
    fragment = lines[end];
    const marker = chapterPattern.test(fragment) ? '章节' : headingPattern.test(fragment) ? '标题'
      : imagePattern.test(fragment.trim()) ? '图片' : '';
    if (marker) {
      throw new Error('第 ' + (end + 1) + ' 行的' + marker + '位于第 ' + (start + 1) + ' 行开始的独立公式内。请先补上结束的 $$。');
    }
  }
  const delimiter = fragment.indexOf('$$');
  chunks.push(fragment.slice(0, delimiter));
  return { end, formula: chunks.join('\n').trim(), trailing: fragment.slice(delimiter + 2).trim() };
}

function displayBoundariesValid(lines, placeholders = new Set()) {
  try {
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].trim().startsWith('$$')) {
        index = readDisplayMath(lines, index, placeholders.has(index + 1)).end;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// The previous editor could insert an empty delimiter inside an existing
// formula. Preserve valid documents, and recover only an unambiguous block.
export function legacyDisplayPlaceholders(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const candidates = new Set();
  const continuation = /^(?:\\|[+\-=<>&(){}\[\]]|[A-Za-z0-9]\s*[_^=+*/&<>-])/;
  for (let index = 0; index + 3 < lines.length; index++) {
    if (lines[index].trim() !== '$$' || lines[index + 1].trim() !== '$$') continue;
    const leading = /^\\([A-Za-z]+)/.exec(lines[index + 2].trim())?.[1];
    if (!leading || /^(?:text.*|emph|end)$/.test(leading)) continue;
    try {
      const block = readDisplayMath(lines, index, true);
      if (lines[block.end].trim() !== '$$') continue;
      if (block.formula.split('\n').slice(1).some(line => !continuation.test(line.trim()))) continue;
      candidates.add(index + 1);
      index = block.end;
    } catch {}
  }
  if (!candidates.size || displayBoundariesValid(lines)) return [];
  return displayBoundariesValid(lines, candidates) ? [...candidates] : [];
}
