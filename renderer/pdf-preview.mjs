import * as pdfjs from './pdfjs/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/build/pdf.worker.min.mjs', import.meta.url).href;
const resource = name => new URL('./pdfjs/' + name + '/', import.meta.url).href;
const scroll = document.querySelector('.preview-scroll');
const pages = document.querySelector('#pdf-pages');
const indicator = document.querySelector('#page-count');
const empty = document.querySelector('#pdf-empty');
let pdf;
let loading;
let observer;
let resizeTimer;
let revision = 0;
let documentRevision = 0;
let zoom = 1;
const rendering = new Set();

function clear() {
  documentRevision++;
  revision++;
  observer?.disconnect();
  observer = null;
  for (const task of rendering) task.cancel();
  rendering.clear();
  pages.replaceChildren();
  empty.hidden = false;
  indicator.textContent = '—';
  const old = loading;
  pdf = loading = null;
  old?.destroy().catch(() => {});
}

async function draw(sheet, number, token) {
  const page = await pdf.getPage(number);
  if (token !== revision) return;
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1.38, (scroll.clientWidth - 60) / base.width) * zoom;
  const viewport = page.getViewport({ scale: Math.max(0.25, scale) });
  const dpi = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'PDF 第 ' + number + ' 页');
  canvas.width = Math.ceil(viewport.width * dpi);
  canvas.height = Math.ceil(viewport.height * dpi);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  const task = page.render({ canvas, viewport, transform: dpi === 1 ? undefined : [dpi, 0, 0, dpi, 0, 0] });
  rendering.add(task);
  try {
    await task.promise;
    if (token === revision) sheet.replaceChildren(canvas);
  } finally {
    rendering.delete(task);
  }
}

async function layOut() {
  if (!pdf || scroll.clientWidth < 100) return;
  const token = ++revision;
  observer?.disconnect();
  for (const task of rendering) task.cancel();
  const first = await pdf.getPage(1);
  if (token !== revision) return;
  const base = first.getViewport({ scale: 1 });
  const width = Math.max(base.width * 0.25, Math.min(base.width * 1.38, scroll.clientWidth - 60) * zoom);
  pages.style.setProperty('--sheet-width', width + 'px');
  pages.style.setProperty('--sheet-ratio', base.width + ' / ' + base.height);
  const sheets = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const sheet = document.createElement('div');
    sheet.className = 'pdf-sheet';
    sheet.dataset.number = number;
    sheets.push(sheet);
  }
  const fragment = document.createDocumentFragment();
  for (const sheet of sheets) fragment.append(sheet);
  pages.replaceChildren(fragment);
  observer = new IntersectionObserver(entries => {
    if (token !== revision) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const sheet = entry.target;
      observer.unobserve(sheet);
      draw(sheet, Number(sheet.dataset.number), token).catch(error => {
        if (token === revision && error.name !== 'RenderingCancelledException') {
          sheet.textContent = '此页预览失败，可导出 PDF 后查看。';
        }
      });
    }
  }, { root: scroll, rootMargin: '280px' });
  for (const sheet of sheets) observer.observe(sheet);
}

export async function show(bytes) {
  const token = ++documentRevision;
  const previous = loading;
  const job = pdfjs.getDocument({
    data: new Uint8Array(bytes), cMapUrl: resource('cmaps'), cMapPacked: true,
    standardFontDataUrl: resource('standard_fonts'), wasmUrl: resource('wasm'),
    iccUrl: resource('iccs'), isEvalSupported: false
  });
  let doc;
  try { doc = await job.promise; } catch (error) {
    await job.destroy().catch(() => {});
    throw error;
  }
  if (token !== documentRevision) {
    await job.destroy();
    return;
  }
  loading = job;
  pdf = doc;
  previous?.destroy().catch(() => {});
  empty.hidden = true;
  indicator.textContent = doc.numPages + ' 页';
  await layOut();
}

export function setZoom(percent) {
  zoom = percent / 100;
  layOut().catch(() => {});
}

export { clear };

new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => layOut().catch(() => {}), 160);
}).observe(scroll);
