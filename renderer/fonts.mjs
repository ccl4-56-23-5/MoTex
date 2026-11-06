// These aliases let the browser shape mixed-script text without decorating editor content.
const categories = {
  chinese: /[\p{Script=Han}&&\p{L}]/v,
  english: /[\p{Script_Extensions=Latin}&&[\p{L}\p{M}]]/v,
  symbols: /[\p{N}\p{P}\p{S}\p{Script=Greek}\u{1d400}-\u{1d7ff}]/u,
};
const ranges = new Map();

function unicodeRanges(key) {
  if (ranges.has(key)) return ranges.get(key);
  const category = categories[key];
  const spans = [];
  let start = -1;
  for (let point = 0; point <= 0x110000; point++) {
    if (point <= 0x10ffff && category.test(String.fromCodePoint(point))) {
      if (start < 0) start = point;
    } else if (start >= 0) {
      const end = point - 1;
      const first = 'U+' + start.toString(16);
      spans.push(end === start ? first : first + '-' + end.toString(16));
      start = -1;
    }
  }
  const result = spans.join(', ');
  ranges.set(key, result);
  return result;
}

const systemDefault = 'var(--default-font-family)';
const nameKey = family => family.toLocaleLowerCase('en-US');

export function createFontPreferences(controls, list) {
  let saved = {};
  let inventory;
  const installed = new Map();
  let activeFaces = [];

  async function loadInventory() {
    if (!window.queryLocalFonts) return;
    try {
      for (const face of await window.queryLocalFonts()) {
        const key = nameKey(face.family);
        const rank = face.fullName === face.family ? 2 : /^(Regular|Normal|Roman|Book)$/i.test(face.style) ? 1 : 0;
        if (!installed.has(key) || installed.get(key).rank < rank) {
          installed.set(key, { family: face.family, local: face.postscriptName || face.fullName, rank });
        }
      }
      if (!installed.size) return;
      const families = [...installed.values()].map(face => face.family).sort((a, b) => a.localeCompare(b, 'zh-CN'));
      list.replaceChildren(...families.map(family => new Option(family, family)));
    } catch {
      // The text inputs and common suggestions also work when enumeration is unavailable.
    }
  }

  return {
    open() {
      for (const control of controls) {
        control.value = saved[control.dataset.font]?.family || '';
      }
      inventory ??= loadInventory();
    },

    values() {
      const values = {};
      for (const control of controls) {
        const family = control.value.trim();
        if (!family) continue;
        const key = control.dataset.font;
        const previous = saved[key];
        const local = installed.get(nameKey(family))?.local || (previous?.family === family ? previous.local : '');
        values[key] = { family, local };
      }
      return values;
    },

    apply(fonts = {}) {
      saved = fonts;
      const style = document.documentElement.style;
      style.setProperty('--sans', fonts.display ? JSON.stringify(fonts.display.family) + ', ' + systemDefault : systemDefault);
      for (const face of activeFaces) document.fonts.delete(face);
      activeFaces = [];
      for (const key of Object.keys(categories)) {
        const setting = fonts[key];
        if (!setting) continue;
        const names = [...new Set([setting.local, setting.family, setting.family + ' Regular'].filter(Boolean))];
        const sources = names.map(name => 'local(' + JSON.stringify(name) + ')').join(', ');
        const face = new FontFace('MoTex-' + key, sources, { unicodeRange: unicodeRanges(key), display: 'swap' });
        document.fonts.add(face);
        activeFaces.push(face);
      }
      style.setProperty('--body-fonts', [...activeFaces.map(face => face.family), systemDefault].join(', '));
      return Promise.allSettled(activeFaces.map(face => face.load()));
    }
  };
}
