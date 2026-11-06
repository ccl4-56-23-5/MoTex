import * as pdf from './pdf-preview.mjs';
import { readImage } from './image-validation.mjs';
import { createEditor } from './editor.mjs';
import { createFontPreferences } from './fonts.mjs';
import { renderAttachments, withoutAttachment } from './attachments.mjs';
import { mountZoteroCollections } from './zotero-collections.mjs';
import { chapterPattern, headingPattern, imagePattern, legacyDisplayPlaceholders, readDisplayMath } from './formula-structure.mjs';

(() => {
  'use strict';
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const editor=createEditor($('#editor'));
  const fontSettings = createFontPreferences($$('[data-font]'), $('#installed-fonts'));
  const templateNames = { note: 'ElegantNote 笔记', thesis: '西交学位论文 · 博士' };
  const api = window.moye;
  const collectionPicker = mountZoteroCollections({
    source: $('#library-source'),
    sort: $('#library-sort'),
    fetchCollections: groupID => api.zoteroCollections(groupID),
    onSelect: changeLibrarySource,
    onLayout: placeLibrary
  });
  const refMap = new Map();
  const assets = new Map();
  let template = 'note', documentId = null, documents = [], metadata = {}, chapters = [];
  let texReady = false, started = false, switching = false, formulaPair = null, imageRequest = null;
  let texEnvironment;
  const maxProjectResources = 85 * 1024 * 1024;
  const maxImages = 120;
  let structureCache;
  const openDocuments = new Set(['']);
  let currentRevision = 0, buildRevision = -1, buildID = '', compileJob, compileTimer, saveTimer, latestLog = '';
  let library = null, searchTimer;
  let savedRange={start:0,end:0},lastFocus=null,toastTimer,renderTimer,usedRefs=[],zoom=100;
  let history=[{text:'',start:0,end:0}],historyIndex=0,composing=false;
  let formulaAfterComposition = false;
  const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function toast(text){const node=$('#toast');node.textContent=text;node.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('show'),2800);}
  function captureRange(){if(document.activeElement===editor.element)savedRange={start:editor.selectionStart,end:editor.selectionEnd};return savedRange;}
  function clampRange(){savedRange.start=Math.max(0,Math.min(editor.value.length,savedRange.start));savedRange.end=Math.max(savedRange.start,Math.min(editor.value.length,savedRange.end));}
  function historyPush() {
    const empty = emptyFormulaPair();
    const value = {
      text: empty ? empty.before + empty.contents + empty.after : editor.value,
      start: positionWithoutPair(editor.selectionStart, empty),
      end: positionWithoutPair(editor.selectionEnd, empty)
    };
    if (history[historyIndex].text === value.text) return;
    history = history.slice(0, historyIndex + 1);
    history.push(value);
    if (history.length > 120) history.shift();
    historyIndex = history.length - 1;
  }
  function restoreHistory(delta){const next=historyIndex+delta;if(next<0||next>=history.length)return;historyIndex=next;formulaPair=null;const item=history[next];editor.value=item.text;editor.focus();editor.setSelectionRange(item.start,item.end);captureRange();render();changed();}
  function closeMenus(){$$('.popover.open').forEach(p=>p.classList.remove('open'));$$('[data-pop]').forEach(b=>b.setAttribute('aria-expanded','false'));closeContext();}
  function openPopover(id,trigger){captureRange();const menu=document.getElementById(id);const opening=!menu.classList.contains('open');closeMenus();if(opening){menu.classList.add('open');trigger.setAttribute('aria-expanded','true');}}
  function closeContext(){$('#context-menu').classList.remove('open');$('#context-headings').classList.remove('open');$('#context-heading-trigger').setAttribute('aria-expanded','false');}
  function showContext(x,y){captureRange();closeMenus();const menu=$('#context-menu');menu.classList.add('open');const bounds=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(x,innerWidth-bounds.width-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-bounds.height-8))+'px';}
  function closeOverlay(restore = true) {
    const open = $('.overlay.open');
    if (!open) return;
    open.classList.remove('open');
    const session = open.id === 'library-overlay' ? library : null;
    if (session) {
      library = null;
      collectionPicker.close();
      clearTimeout(searchTimer);
      if (restore) {
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(session.range.start, session.range.end);
        captureRange();
      }
    } else if (restore && lastFocus?.isConnected) {
      lastFocus.focus();
    }
  }
  function overlay(id){captureRange();closeMenus();closeOverlay(false);lastFocus=document.activeElement;const root=document.getElementById(id);root.classList.add('open');const input=$('input,button,select',root);if(input)input.focus();}
  function info(title,text){$('#info-title').textContent=title;$('#info-text').textContent=text;overlay('info-overlay');}
  function insertText(text,{block=false}={}){closeMenus();clampRange();let insert=text;if(block){if(savedRange.start>0&&editor.value[savedRange.start-1]!=='\n')insert='\n\n'+insert;if(savedRange.end<editor.value.length&&editor.value[savedRange.end]!=='\n')insert+='\n\n';}
    const start=savedRange.start,end=savedRange.end;editor.focus();editor.setSelectionRange(start,end);editor.setRangeText(insert,start,end,'end');captureRange();historyPush();render();changed();}
  function lineInfo(pos=savedRange.start){const text=editor.value;const start=pos===0?0:text.lastIndexOf('\n',pos-1)+1;let end=text.indexOf('\n',pos);if(end===-1)end=text.length;const line=text.slice(start,end),match=line.match(/^(#{1,6})\s/);return {start,end,line,level:match?match[1].length:0};}
  function editorStructure() {
    const text = editor.value;
    if (structureCache?.text === text) return structureCache;
    const lines = text.split('\n');
    const offsets = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }
    const placeholders = new Set(legacyDisplayPlaceholders(text));
    const blocks = new Map();
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim().startsWith('$$')) continue;
      let end;
      try {
        end = readDisplayMath(lines, index, placeholders.has(index + 1)).end;
      } catch {
        end = lines.length - 1;
      }
      blocks.set(index, end);
      index = end;
    }
    structureCache = { text, lines, offsets, blocks };
    return structureCache;
  }

  function insideDisplayMath(pos) {
    const { lines, offsets, blocks } = editorStructure();
    for (const [start, end] of blocks) {
      if (pos < offsets[start]) return false;
      if (pos <= offsets[end] + lines[end].length) return true;
    }
    return false;
  }

  function setHeading(level){clampRange();const a=lineInfo(savedRange.start);const effectiveEnd=savedRange.end>savedRange.start&&editor.value[savedRange.end-1]==='\n'?savedRange.end-1:savedRange.end;const b=lineInfo(effectiveEnd);
    if(insideDisplayMath(a.start)){toast('请在公式外设置标题层级');return;}
    const selection=editor.value.slice(a.start,b.end);if(selection.split('\n').some(l=>l.trim().startsWith('$$') || l.startsWith(':::chapter ') || imagePattern.test(l.trim()))){toast('请选择章内小节或正文');return;}
    const transformed=selection.split('\n').map(line=>{const plain=line.replace(/^#{1,6}\s+/,'');if(!plain.trim()&&selection.includes('\n'))return plain;return (level?'#'.repeat(level)+' ':'')+plain;}).join('\n');
    const wasSelection=savedRange.end>savedRange.start;
    editor.focus();editor.setSelectionRange(a.start,b.end);editor.setRangeText(transformed,a.start,b.end,'select');
    if(!wasSelection){const plainOffset=Math.max(0,savedRange.start-a.start-(a.level?a.level+1:0));const pos=Math.min(a.start+transformed.length,a.start+(level?level+1:0)+plainOffset);editor.setSelectionRange(pos,pos);}
    captureRange();closeMenus();historyPush();render();changed();}
  function outlineModel() {
    const chapters = [];
    const counters = Array(6).fill(0);
    let chapter;
    const { lines, offsets, blocks } = editorStructure();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const marker = line.match(chapterPattern);
      if (marker || (!chapter && line.trim())) {
        chapter = { no: chapters.length + 1, title: marker?.[1] || '', start: offsets[index], sections: [] };
        chapters.push(chapter);
        counters.fill(0);
      }
      if (blocks.has(index)) {
        index = blocks.get(index);
        continue;
      }
      const match = line.match(headingPattern);
      if (match && chapter) {
        const level = match[1].length;
        counters[level - 1]++;
        counters.fill(0, level);
        chapter.sections.push({ level, title: match[2], start: offsets[index], no: [chapter.no, ...counters.slice(0, level)].join('.') });
      }
    }
    return chapters;
  }

  function renderWorkspace() {
    const list = $('#workspace-documents');
    const contents = $('#document-details');
    $('#sidebar').insertBefore(contents, $('.side-bottom'));
    contents.hidden = true;
    list.replaceChildren();
    const entries = documentId ? documents : [{ id: '', name: '未命名文档' }, ...documents];

    for (const { id, name } of entries) {
      const active = id === (documentId || '');
      const row = document.createElement('details');
      row.className = 'workspace-document' + (active ? ' current' : '');
      row.dataset.document = id;
      row.open = openDocuments.has(id);
      row.addEventListener('toggle', () => {
        if (!row.isConnected) return;
        if (row.open) openDocuments.add(id);
        else openDocuments.delete(id);
      });
      const summary = document.createElement('summary');
      summary.innerHTML = '<svg class="chev"><use href="#i-down"/></svg><svg><use href="#i-file"/></svg><span class="document-name"></span>';
      $('.document-name', summary).textContent = active ? ($('#doc-title').value || name) : name;
      row.append(summary);
      if (active) {
        contents.hidden = false;
        row.append(contents);
      } else {
        const open = document.createElement('button');
        open.className = 'document-open';
        open.dataset.openDocument = id;
        open.textContent = '打开文档';
        row.append(open);
      }
      list.append(row);
    }
  }

  function renderOutline() {
    const outline = $('#outline');
    const closed = new Set($$('.outline-chapter:not([open])', outline).map(row => row.dataset.chapter));
    chapters = outlineModel();
    const numbered = $('#numbering').value === 'auto';
    outline.innerHTML = chapters.map(chapter => {
      const label = '第 ' + chapter.no + ' 章';
      const title = chapter.title ? label + '　' + chapter.title : label;
      const children = chapter.sections.map(section =>
        '<button class="outline-item level-' + section.level + '" data-outline data-start="' + section.start + '">' +
        (numbered ? '<span class="outline-no">' + section.no + '</span>' : '') +
        '<span>' + escapeHTML(section.title || '未命名小节') + '</span></button>'
      ).join('');
      return '<details class="outline-chapter" data-chapter="' + chapter.no + '" ' + (closed.has(String(chapter.no)) ? '' : 'open') + '>' +
        '<summary><svg class="chev"><use href="#i-down"/></svg><button data-outline data-start="' + chapter.start +
        '" title="' + escapeHTML(title) + '"><span>' + escapeHTML(title) + '</span></button></summary>' +
        '<div class="outline-section">' + children + '</div></details>';
    }).join('');
  }

  function render() {
    renderOutline();
    usedRefs = [...new Set([...editor.value.matchAll(/\[@([A-Za-z0-9_:.+\/-]+)\]/g)].map(match => match[1]))]
      .filter(key => refMap.has(key));
    $('#cite-count').textContent = '引用 ' + usedRefs.length + ' 篇';
    $('#char-count').textContent = editor.value.replace(/\s/g, '').length + ' 字符';
    renderAttachments({ text: editor.value, chapters, assets, onDelete: (...args) => removeAttachment(...args) });
    const title = $('#doc-title').value || '未命名文档';
    $('#project-name').textContent = title;
    const name = $('.workspace-document.current .document-name');
    if (name) name.textContent = title;
    updateCursor();
  }

  function updateCursor() {
    const pos = editor.selectionStart;
    const prefix = editor.value.slice(0, pos);
    const line = prefix.split('\n').length;
    const col = pos - (prefix.lastIndexOf('\n') + 1) + 1;
    $('#cursor-status').textContent = '第 ' + line + ' 行，第 ' + col + ' 列';
    const current = lineInfo(pos);
    const labels = ['', '一级小节', '二级小节', '三级小节', '四级小节', '五级小节', '六级小节'];
    $('#heading-name').textContent = current.line.startsWith(':::chapter ') ? '章节' : (labels[current.level] || '正文');
    const chapter = chapters.findLast(item => item.start <= pos);
    $('#active-chapter').textContent = chapter ? '第 ' + chapter.no + ' 章' + (chapter.title ? '　' + chapter.title : '') : '';
    $$('#heading-menu [data-heading]').forEach(button => button.classList.toggle('selected', Number(button.dataset.heading) === current.level));
    $$('#outline [data-outline]').forEach((button, index, items) => {
      const next = items[index + 1] ? Number(items[index + 1].dataset.start) : Infinity;
      button.classList.toggle('active', pos >= Number(button.dataset.start) && pos < next);
    });
  }

  function liveFormulaPair() {
    if (!formulaPair) return null;
    const { before, after, source } = formulaPair;
    const text = editor.value;
    const start = before.length;
    const end = text.length - after.length;
    if (end - start < 2 || !text.startsWith(before + '$') || !text.endsWith('$' + after)) {
      formulaPair = null;
      return null;
    }
    return { start, end, before, after, source, contents: text.slice(start + 1, end - 1) };
  }

  function emptyFormulaPair() {
    const pair = liveFormulaPair();
    return pair && !pair.contents.trim() ? pair : null;
  }

  function positionWithoutPair(position, pair) {
    return pair ? position - (position > pair.start ? 1 : 0) - (position >= pair.end ? 1 : 0) : position;
  }

  function discardEmptyFormula() {
    const pair = emptyFormulaPair();
    if (!pair) return;
    const range = { start: positionWithoutPair(editor.selectionStart, pair), end: positionWithoutPair(editor.selectionEnd, pair) };
    formulaPair = null;
    editor.setRangeText(pair.contents, pair.start, pair.end, 'end');
    editor.setSelectionRange(range.start, range.end);
    savedRange = range;
    historyPush();
    render();
    changed();
  }

  function formulaPosition(pos) {
    const info = lineInfo(pos);
    if (info.line.trim().startsWith('$$') || insideDisplayMath(pos)) return true;
    const offset = pos - info.start;
    const inline = /\\\$|\$((?:\\[^\r\n]|[^\\$\r\n])+)\$/g;
    return [...info.line.matchAll(inline)].some(match => match[1] && offset > match.index && offset < match.index + match[0].length);
  }

  function formulaRange(range) {
    const last = Math.max(range.start, range.end - 1);
    if (formulaPosition(range.start) || formulaPosition(last)) return true;
    return range.end > range.start && /^\s*\$\$/m.test(editor.value.slice(range.start, range.end));
  }

  function startFormula(source = 'shortcut') {
    captureRange();
    clampRange();
    const pending = liveFormulaPair();
    if (pending && savedRange.start > pending.start && savedRange.end < pending.end) return;
    discardEmptyFormula();
    if (formulaRange(savedRange)) {
      toast('请在现有公式之外插入新公式');
      return;
    }
    const { start, end } = savedRange;
    if (editor.value.slice(lineInfo(start).start, lineInfo(end).end).split('\n').some(line => imagePattern.test(line.trim()))) {
      toast('请在图片题注之外插入公式');
      return;
    }
    if (editor.value.length + 2 > editor.maxLength) {
      toast('正文长度达到上限，无法插入公式');
      return;
    }
    const selected = editor.value.slice(start, end);
    formulaPair = { before: editor.value.slice(0, start), after: editor.value.slice(end), source };
    editor.setRangeText('$' + selected + '$', start, end, 'end');
    editor.setSelectionRange(start + 1, start + selected.length + 1);
    captureRange();
    historyPush();
    render();
    changed();
  }

  function typeDollar() {
    captureRange();
    clampRange();
    const { start, end } = savedRange;
    const text = editor.value;
    let slash = start;
    while (slash > 0 && text[slash - 1] === '\\') slash--;
    if ((start - slash) % 2) return false;

    const pair = liveFormulaPair();
    if (pair && start === end && start === pair.end - 1) {
      const rawDisplay = pair.source === 'dollar' && !pair.contents &&
        !pair.before.slice(pair.before.lastIndexOf('\n') + 1).trim();
      editor.setSelectionRange(pair.end, pair.end);
      if (rawDisplay) {
        formulaPair = null;
        historyPush();
        render();
        changed();
      } else if (!pair.contents.trim()) {
        discardEmptyFormula();
      } else {
        formulaPair = null;
        captureRange();
        updateCursor();
      }
      return true;
    }

    if (insideDisplayMath(start) || lineInfo(start).line.trim().startsWith('$$')) return false;
    if (start === end) {
      const prefix = text.slice(lineInfo(start).start, start);
      const delimiters = prefix.match(/\\.|\$/g) || [];
      if (delimiters.filter(token => token === '$').length % 2) {
        if (text[start] !== '$') return false;
        editor.setSelectionRange(start + 1, start + 1);
        captureRange();
        updateCursor();
        return true;
      }
    }
    if (formulaRange(savedRange)) return false;
    startFormula('dollar');
    return true;
  }

  function inputFormulaDollar() {
    if (document.activeElement !== editor.element || switching) return;
    if (composing) {
      formulaAfterComposition = true;
      return;
    }
    if (!typeDollar()) insertText('$');
  }

  function finishFormula() {
    const pair = liveFormulaPair();
    if (!pair || editor.selectionStart <= pair.start || editor.selectionEnd >= pair.end) return false;
    const { start, end, before, after, contents } = pair;
    const formula = contents.trim();
    const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
    const suffix = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const block = prefix + '$$\n' + formula + '\n$$' + suffix;
    if (editor.value.length - (end - start) + block.length > editor.maxLength) {
      toast('正文长度达到上限，无法插入公式');
      return true;
    }
    formulaPair = null;
    editor.setRangeText(block, start, end, 'end');
    const caret = formula
      ? editor.selectionEnd + (after.startsWith('\n\n') ? 2 : after.startsWith('\n') ? 1 : 0)
      : start + prefix.length + '$$\n'.length;
    editor.setSelectionRange(caret, caret);
    captureRange();
    historyPush();
    render();
    changed();
    return true;
  }

  function snapshot() {
    const empty = emptyFormulaPair();
    return {
      format: 1,
      title: $('#doc-title').value,
      text: empty ? empty.before + empty.contents + empty.after : editor.value,
      template,
      numbering: $('#numbering').value,
      metadata,
      images: [...assets.values()],
      references: [...refMap.values()]
    };
  }

  function showFile() {
    $('#project-file').textContent = documentId || '未保存文档';
  }

  async function persist() {
    clearTimeout(saveTimer);
    const revision = currentRevision;
    try {
      const persisted = await api.saveDraft({ project: snapshot(), id: documentId });
      if (persisted && revision === currentRevision) $('#draft-state').textContent = documentId ? '文档已保存' : '草稿已保存';
      return persisted;
    } catch (error) {
      $('#draft-state').textContent = '保存失败';
      toast(error.message);
      return false;
    }
  }

  function changed() {
    if (!started) return;
    currentRevision++;
    $('#draft-state').textContent = '正在保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
    scheduleCompile();
  }

  function scheduleCompile(delay = 650) {
    clearTimeout(compileTimer);
    if (!texReady) return;
    if (!compileJob) $('#compile-state').textContent = '等待编译当前版本';
    compileTimer = setTimeout(() => { void compilePreview(); }, delay);
  }

  function compilePreview() {
    clearTimeout(compileTimer);
    if (!texReady) {
      $('#compile-state').textContent = '请在偏好设置中配置 TeX Live';
      return Promise.resolve(false);
    }
    if (compileJob) return compileJob;
    const revision = currentRevision;
    const source = snapshot();
    const target = documentId;
    if (!source.text.trim() && !source.title.trim()) {
      $('#compile-state').textContent = '等待正文';
      return Promise.resolve(false);
    }
    const status = $('#compile-state');
    status.title = '';
    status.textContent = 'XeLaTeX 正在编译…';
    compileJob = (async () => {
      try {
        const result = await api.compile(source, target);
        if (revision !== currentRevision) return false;
        latestLog = result.log || '';
        $('#compile-log').hidden = !latestLog;
        if (!result.ok) {
          const lines = latestLog.split(/\r?\n/);
          const reason = lines.find(line => /^第 \d+ 行/.test(line))
            || lines.find(line => /^\.\/main\.tex:\d+:/.test(line));
          status.textContent = reason ? '编译失败 · ' + reason : buildID ? '编译失败 · 保留上次 PDF' : '编译失败';
          status.title = reason || '查看日志了解详细错误';
          return false;
        }
        await pdf.show(result.bytes);
        if (revision !== currentRevision) return false;
        buildID = result.id;
        buildRevision = revision;
        $('#compile-state').textContent = result.reused ? 'PDF 已就绪' : 'PDF 已更新';
        if (target && revision === currentRevision) {
          try {
            await api.publishBuild(result.id);
          } catch (error) {
            $('#compile-state').textContent = '预览已更新 · 工程输出保存失败';
            latestLog = error.message + '\n' + latestLog;
            $('#compile-log').hidden = false;
          }
        }
        return true;
      } catch (error) {
        if (revision === currentRevision) {
          latestLog = error.message;
          $('#compile-log').hidden = false;
          $('#compile-state').textContent = buildID ? '预览更新失败 · 保留上次页面' : '无法生成预览';
        }
        return false;
      } finally {
        compileJob = null;
        if (revision !== currentRevision) scheduleCompile(350);
      }
    })();
    return compileJob;
  }

  async function currentPDF() {
    if (buildRevision === currentRevision && buildID && !compileJob) return buildID;
    if (compileJob) await compileJob;
    if (buildRevision === currentRevision && buildID) return buildID;
    if (await compilePreview()) return buildID;
    toast(texReady ? '请检查编译日志后重试' : '请先配置 TeX Live');
    return null;
  }

  function loadProject(project, id = null, items = documents) {
    currentRevision++;
    buildRevision = -1;
    buildID = latestLog = '';
    $('#compile-log').hidden = true;
    pdf.clear();
    documentId = id;
    documents = items;
    metadata = { ...project.metadata };
    formulaPair = null;
    imageRequest = null;
    openDocuments.add(id || '');
    $('#outline').replaceChildren();
    $('#doc-title').value = project.title;
    editor.value = project.text;
    editor.setSelectionRange(0, 0);
    savedRange = { start: 0, end: 0 };
    history = [{ text: project.text, start: 0, end: 0 }];
    historyIndex = 0;
    refMap.clear();
    assets.clear();
    project.references.forEach(ref => refMap.set(ref.key, ref));
    project.images.forEach(img => assets.set(img.id, img));
    $('#numbering').value = project.numbering;
    chooseTemplate(project.template, false);
    renderWorkspace();
    render();
    showFile();
    scheduleCompile(120);
  }

  function updateTex(result) {
    const tex = result.tex;
    const environmentChanged = tex.compiler !== texEnvironment?.compiler || tex.biber !== texEnvironment?.biber;
    texEnvironment = tex;
    texReady = Boolean(tex.ready);
    $('#tex-bin').value = result.texBin;
    $('#tex-bin').placeholder = tex.bin || 'D:\\texlive\\2026\\bin\\windows';
    $('#tex-state').textContent = texReady ? 'TeX Live · 已连接' : 'TeX Live · 待配置';
    $('#tex-message').textContent = texReady ? (tex.biber ? '已检测到 XeLaTeX 与 Biber · ' : '已检测到 XeLaTeX，引用编译需要 Biber · ') + tex.bin :
      (tex.message || '未找到可用的 TeX Live bin 目录');
    if (!texReady) $('#compile-state').textContent = '请在偏好设置中配置 TeX Live';
    return environmentChanged;
  }

  function updateFonts(result) {
    $('#font-size').value = result.fontSize;
    editor.style.fontSize = result.fontSize + 'px';
    const ready = fontSettings.apply(result.fonts);
    editor.requestMeasure();
    void ready.then(() => editor.requestMeasure());
  }

  async function initialize() {
    try {
      const result = await api.load();
      $('.version').textContent = result.version;
      updateTex(result);
      updateFonts(result);
      loadProject(result.draft || {
        format: 1, title: '', text: '', template: 'note', numbering: 'auto', images: [], references: []
      }, result.id, result.projects);
      started = true;
      $('#draft-state').textContent = result.id ? '文档已保存' : '本机草稿';
    } catch (error) {
      info('墨页启动提示', error.message);
    }
  }

  function citationAnchor(range) {
    const rect = editor.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      const pane = $('#panes').getBoundingClientRect();
      return { x: pane.left + 18, y: pane.top + 36 };
    }
    const caret = editor.coordsAtPos(range.start);
    const x = caret?.left ?? rect.left;
    const y = (caret?.bottom ?? rect.top) + 5;
    return {
      x: Math.max(rect.left, Math.min(x, rect.right)),
      y: Math.max(rect.top + 12, Math.min(y, rect.bottom))
    };
  }

  function placeLibrary() {
    if (!library) return;
    const menu = $('.citation-menu');
    const anchor = library.anchor;
    const margin = 12;
    const x = Math.max(margin, Math.min(anchor.x, innerWidth - menu.offsetWidth - margin));
    const above = anchor.y - menu.offsetHeight - 25;
    const desiredY = anchor.y + menu.offsetHeight > innerHeight - margin && above >= margin ? above : anchor.y;
    const y = Math.max(margin, Math.min(desiredY, innerHeight - menu.offsetHeight - margin));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function localSource() {
    return ['used', 'selected'].includes($('#library-source').value);
  }

  function renderLibrary() {
    const session = library;
    if (!session) return;
    const list = $('#reference-list');
    const scrollTop = list.scrollTop;
    const query = $('#library-search').value.trim().toLocaleLowerCase();
    const rows = session.rows.map((row, index) => ({ row, index }));
    let visible = rows;
    if (localSource()) {
      visible = rows.filter(({ row }) => [row.title, row.author, row.year, row.key].join(' ').toLocaleLowerCase().includes(query));
      const sort = $('#library-sort').value;
      if (sort === 'title') visible.sort((a, b) => a.row.title.localeCompare(b.row.title, 'zh-CN'));
      if (sort === 'date') visible.sort((a, b) => Number(b.row.year) - Number(a.row.year));
    }
    const pending = session.loading || session.citing;
    const status = session.citing ? '正在插入引用…' :
      session.loading ? '正在读取 Zotero…' :
      session.error || (visible.length ? '已显示 ' + visible.length + ' 条 · 单击插入' : '可按标题、作者或年份搜索');
    $('#result-count').textContent = status;
    const more = $('#library-more');
    more.hidden = session.nextStart === null;
    more.disabled = pending;
    list.setAttribute('aria-busy', String(pending));
    const empty = session.error || (session.loading ? '正在读取文库…' :
      session.nextStart !== null ? '本页没有可引用条目，可加载更多。' : '没有符合条件的文献。');
    list.innerHTML = visible.length ? visible.map(({ row, index }) =>
      '<button class="reference-item" data-cite="' + index + '" ' + (session.citing ? 'disabled ' : '') +
      'aria-label="插入引用 ' + escapeHTML(row.title) + '" title="' + escapeHTML(row.title) + '">' +
      '<span class="ref-main"><span class="ref-title">' + escapeHTML(row.title) +
      '</span><span class="ref-meta">' + escapeHTML([row.author, row.year, row.type].filter(Boolean).join(' · ')) +
      '</span></span><span class="ref-insert"><svg aria-hidden="true"><use href="#i-plus"/></svg></span></button>'
    ).join('') : '<div class="empty-state">' + escapeHTML(empty) + '</div>';
    list.scrollTop = scrollTop;
    placeLibrary();
  }

  async function loadLibrary(append = false) {
    const session = library;
    if (!session || (append && (session.loading || session.citing || session.nextStart === null))) return;
    const request = ++session.request;
    const start = append ? session.nextStart : 0;
    if (!append) {
      session.rows = [];
      session.nextStart = null;
      $('#reference-list').scrollTop = 0;
    }
    const source = $('#library-source').value;
    const query = $('#library-search').value.trim();
    const sort = $('#library-sort').value;
    session.loading = true;
    session.error = '';
    renderLibrary();

    try {
      let page;
      if (source === 'used') {
        page = { items: usedRefs.map(key => refMap.get(key)), nextStart: null };
      } else if (source === 'selected') {
        page = { items: await api.zoteroSelection(), nextStart: null };
      } else {
        page = await api.searchZotero(query, source === 'all' ? null : source, start, sort, collectionPicker.key);
      }
      if (library !== session || request !== session.request) return;
      const seen = new Set(session.rows.map(row => row.id));
      for (const row of page.items) {
        if (seen.has(row.id)) continue;
        session.rows.push(row);
        seen.add(row.id);
      }
      session.nextStart = page.nextStart;
    } catch (error) {
      if (library !== session || request !== session.request) return;
      session.error = error.message;
    } finally {
      if (library === session && request === session.request) {
        session.loading = false;
        renderLibrary();
      }
    }
  }

  async function openLibrary() {
    discardEmptyFormula();
    captureRange();
    clampRange();
    const range = { ...savedRange };
    render();
    overlay('library-overlay');
    const session = { range, anchor: citationAnchor(range), revision: currentRevision, rows: [], nextStart: null, request: 0, loading: false, citing: false, error: '' };
    library = session;
    const source = $('#library-source');
    for (const option of [...source.querySelectorAll('[data-group]')]) option.remove();
    source.value = 'all';
    void collectionPicker.reset();
    $('#library-search').value = '';
    $('#library-search').focus({ preventScroll: true });
    void loadLibrary();
    const groups = await api.zoteroGroups().catch(() => []);
    if (library !== session) return;
    for (const group of groups) {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      option.dataset.group = 'true';
      source.append(option);
    }
  }

  async function insertCitation(index) {
    const session = library;
    const item = session?.rows[index];
    if (!item || session.citing || session.revision !== currentRevision) return;
    session.citing = true;
    session.error = '';
    renderLibrary();
    try {
      const stored = [...refMap.values()].find(ref => ref.id === item.id);
      const ref = stored || await api.citeZotero(item, [...refMap.values()].map(({ id, key }) => ({ id, key })));
      if (library !== session || session.revision !== currentRevision) return;
      refMap.set(ref.key, ref);
      closeOverlay(false);
      savedRange = { ...session.range };
      insertText('[@' + ref.key + ']');
      toast('已引用「' + ref.title + '」');
    } catch (error) {
      if (library === session) session.error = error.message;
    } finally {
      if (library === session) {
        session.citing = false;
        renderLibrary();
      }
    }
  }

  function setLayout(mode) {
    $('#panes').className = 'panes' + (mode === 'focus' ? ' focus-mode' : mode === 'preview' ? ' preview-only' : '');
    $('#layout-label').textContent = ({split:'左右分屏',focus:'专注写作',preview:'仅预览'})[mode];
    closeMenus();
  }

  function chooseTemplate(key, edit = true) {
    if (!templateNames[key]) return;
    const different = key !== template;
    template = key;
    $('#template-name').textContent = templateNames[key];
    $('#metadata-command').hidden = key !== 'thesis';
    $$('[data-template]').forEach(button => {
      button.classList.toggle('active', button.dataset.template === key);
      $('.check', button).textContent = button.dataset.template === key ? '✓' : '';
    });
    closeMenus();
    if (edit && different) changed();
  }

  async function removeAttachment(assetId) {
    const asset = assets.get(assetId);
    if (!asset || switching || !confirm('删除这张图片的工程附件及正文中的引用？')) return;
    switching = true;
    editor.readOnly = $('#doc-title').readOnly = true;
    try {
      discardEmptyFormula();
      clearTimeout(compileTimer);
      if (compileJob) await compileJob;
      clearTimeout(compileTimer);
      if (!await persist()) return;
      const project = snapshot();
      project.text = withoutAttachment(project.text, assetId);
      project.images = project.images.filter(item => item.id !== assetId);
      const result = await api.removeAttachment({ project, id: documentId, assetId });
      assets.delete(assetId);
      editor.value = project.text;
      history = history.map(item => {
        const text = withoutAttachment(item.text, assetId);
        return { text, start: Math.min(item.start, text.length), end: Math.min(item.end, text.length) };
      });
      formulaPair = null;
      const caret = Math.min(savedRange.start, project.text.length);
      editor.setSelectionRange(caret, caret);
      savedRange = { start: caret, end: caret };
      historyPush();
      render();
      changed();
      toast(result.generatedCopiesRemoved ? '附件已从工程删除' : '附件已删除，部分旧编译文件会在下次编译时更新');
    } catch (error) {
      toast(error.message || '删除附件失败');
    } finally {
      switching = false;
      editor.readOnly = $('#doc-title').readOnly = false;
    }
  }

  async function switchDocument(operation, preserveDraft = true) {
    if (switching) return;
    editor.commitCaption();
    switching = true;
    editor.readOnly = $('#doc-title').readOnly = true;
    try {
      if (!await persist()) return;
      if (preserveDraft && !documentId && ($('#doc-title').value.trim() || editor.value.trim() || assets.size || refMap.size)) {
        const saved = await api.saveProject(snapshot(), false);
        if (saved?.project) loadProject(saved.project, saved.id, saved.projects);
      }
      const result = await operation();
      if (!result) return;
      closeOverlay(false);
      if (result.project) {
        loadProject(result.project, result.id, result.projects);
        $('#draft-state').textContent = '文档已保存';
        editor.focus();
      } else {
        $('#draft-state').textContent = '文档已保存';
      }
      return result;
    } finally {
      switching = false;
      editor.readOnly = $('#doc-title').readOnly = false;
    }
  }

  async function action(name) {
    try {
      switch (name) {
        case 'sidebar': {
          const closed = $('#sidebar').classList.toggle('closed');
          $('#sidebar-toggle').setAttribute('aria-expanded', !closed);
          closeMenus();
          break;
        }
        case 'library': await openLibrary(); break;
        case 'library-more': await loadLibrary(true); break;
        case 'guide': overlay('guide-overlay'); break;
        case 'settings':
          overlay('settings-overlay');
          fontSettings.open();
          break;
        case 'about':
          info('墨页 MoTex ' + $('.version').textContent, '使用本机 TeX Live 编译。工程目录包含文档、LaTeX 源码和 PDF。');
          break;
        case 'choose-tex': {
          const dir = await api.chooseTex();
          if (dir) $('#tex-bin').value = dir;
          break;
        }
        case 'apply-settings': {
          const button = $('[data-action="apply-settings"]');
          if (button.disabled) break;
          button.disabled = true;
          try {
            const result = await api.saveSettings({
              texBin: $('#tex-bin').value,
              fontSize: $('#font-size').value,
              fonts: fontSettings.values()
            });
            const environmentChanged = updateTex(result);
            updateFonts(result);
            await persist();
            if (texReady && $('#settings-overlay').classList.contains('open')) closeOverlay();
            if (texReady && environmentChanged) {
              currentRevision++;
              scheduleCompile(120);
            }
          } finally {
            button.disabled = false;
          }
          break;
        }
        case 'new':
          $('#new-title').value = '';
          $('#new-template').value = 'note';
          overlay('new-document-overlay');
          $('#new-title').focus();
          break;
        case 'create-document': {
          const title = $('#new-title').value.trim();
          if (!title) { $('#new-title').focus(); break; }
          await switchDocument(() => api.newProject({ title, template: $('#new-template').value }));
          break;
        }
        case 'open':
          closeMenus();
          await switchDocument(() => api.openProject());
          break;
        case 'save':
        case 'save-as':
          closeMenus();
          if (await switchDocument(() => api.saveProject(snapshot(), name === 'save-as'), false)) toast('文档已保存');
          break;
        case 'reveal':
          closeMenus();
          await api.revealProject();
          break;
        case 'chapter':
          captureRange();
          if (insideDisplayMath(savedRange.start) || lineInfo().line.trim().startsWith('$$')) {
            closeMenus();
            toast('请在公式之外插入章节');
            break;
          }
          $('#chapter-title').value = '';
          overlay('chapter-overlay');
          $('#chapter-title').focus();
          break;
        case 'create-chapter': {
          const title = $('#chapter-title').value.trim();
          if (!title) { $('#chapter-title').focus(); break; }
          closeOverlay(false);
          savedRange.end = savedRange.start;
          insertText(':::chapter ' + title + '\n', { block: true });
          break;
        }
        case 'metadata':
          for (const input of $$('[data-metadata]')) input.value = metadata[input.dataset.metadata] || '';
          overlay('metadata-overlay');
          $('[data-metadata]').focus();
          break;
        case 'apply-metadata':
          metadata = Object.fromEntries($$('[data-metadata]').map(input => [input.dataset.metadata, input.value.trim()]));
          closeOverlay();
          changed();
          break;
        case 'image':
          captureRange();
          discardEmptyFormula();
          closeMenus();
          clampRange();
          if (formulaRange(savedRange)) {
            toast('请把光标移到公式之外再插入图片');
            break;
          }
          imageRequest = { documentId, text: editor.value, range: { ...savedRange } };
          $('#image-input').value = '';
          $('#image-input').click();
          break;
        case 'context': {
          const rect = editor.getBoundingClientRect();
          showContext(Math.min(rect.left + 28, innerWidth - 260), Math.min(rect.top + 65, innerHeight - 260));
          $('#context-menu button').focus();
          break;
        }
        case 'promote': setHeading(Math.max(0, lineInfo().level - 1)); break;
        case 'demote': setHeading(Math.min(6, lineInfo().level + 1)); break;
        case 'refresh':
          if (compileJob) await compileJob;
          else await compilePreview();
          break;
        case 'compile-log': info('LaTeX 编译日志', latestLog); break;
        case 'zoom-in':
        case 'zoom-out':
          zoom = Math.max(60, Math.min(200, zoom + (name === 'zoom-in' ? 10 : -10)));
          pdf.setZoom(zoom);
          $('#zoom-label').textContent = zoom + '%';
          break;
        case 'download-source': {
          closeMenus();
          if (await api.exportSource('markdown', snapshot())) toast('正文已导出');
          break;
        }
        case 'export-pdf':
        case 'export-latex':
        case 'window': {
          closeMenus();
          const id = await currentPDF();
          if (!id) break;
          if (name === 'window') await api.openPDF(id);
          else if (name === 'export-pdf') {
            if (await api.exportPDF(id, $('#doc-title').value)) toast('PDF 已导出');
          } else if (await api.exportSource('latex', snapshot(), id)) toast('LaTeX 工程已导出');
          break;
        }
      }
    } catch (error) {
      toast(error.message);
    }
  }

  api.onFlush(async () => {
    editor.commitCaption();
    await api.close(await persist() || confirm('草稿保存失败。确定关闭墨页吗？'));
  });
  document.addEventListener('mousedown',e=>{if(!editor.element.contains(e.target)&&document.activeElement===editor.element)captureRange();});
  document.addEventListener('click',e=>{
    const pop=e.target.closest('[data-pop]');if(pop){openPopover(pop.dataset.pop,pop);return;}
    const heading=e.target.closest('[data-heading]');if(heading){setHeading(Number(heading.dataset.heading));return;}
    const documentButton = e.target.closest('[data-open-document]');
    if (documentButton) {
      const id = documentButton.dataset.openDocument;
      void switchDocument(() => api.activateProject(id)).catch(error => toast(error.message));
      return;
    }
    const cite=e.target.closest('[data-cite]');if(cite){void insertCitation(Number(cite.dataset.cite));return;}
    const template=e.target.closest('[data-template]');if(template){chooseTemplate(template.dataset.template);return;}
    const layout=e.target.closest('[data-layout]');if(layout){setLayout(layout.dataset.layout);return;}
    const outline=e.target.closest('[data-outline]');if(outline){e.preventDefault();const pos=Number(outline.dataset.start);editor.focus();editor.setSelectionRange(pos,pos);editor.scrollIntoView(pos);captureRange();updateCursor();if(innerWidth<=800){$('#sidebar').classList.add('closed');$('#sidebar-toggle').setAttribute('aria-expanded','false');}return;}
    const a=e.target.closest('[data-action]');if(a){void action(a.dataset.action);return;}
    if(e.target.closest('[data-close]')){closeOverlay();return;}
    if(e.target.classList.contains('overlay')){closeOverlay();return;}
    if(!e.target.closest('.menu-anchor')&&!e.target.closest('.context-menu'))closeMenus();
  });
  $('#context-heading-trigger').addEventListener('click',()=>{const sub=$('#context-headings');const opened=sub.classList.toggle('open');$('#context-heading-trigger').setAttribute('aria-expanded',opened);if(opened&&innerWidth>560){const rect=$('#context-menu').getBoundingClientRect();const left=rect.right+251<innerWidth;sub.style.left=left?'calc(100% + 5px)':'auto';sub.style.right=left?'auto':'calc(100% + 5px)';}});
  editor.addEventListener('mousedown',e=>{if(e.button===2){e.preventDefault();captureRange();}});
  editor.addEventListener('contextmenu',e=>{e.preventDefault();showContext(e.clientX,e.clientY);$('#context-menu button').focus();});
  api.onFormulaKey(inputFormulaDollar);
  editor.addEventListener('focus', () => api.setEditorFocus(true));
  editor.addEventListener('blur', () => {
    api.setEditorFocus(false);
    formulaAfterComposition = false;
    discardEmptyFormula();
  });
  editor.addEventListener('compositionstart',()=>composing=true);
  editor.addEventListener('compositionend', () => {
    composing = false;
    captureRange();
    historyPush();
    render();
    changed();
    if (formulaAfterComposition) {
      formulaAfterComposition = false;
      inputFormulaDollar();
    }
  });
  editor.addEventListener('keydown', event => {
    if (event.target !== editor.element || event.code !== 'Digit4' || !event.shiftKey ||
        event.ctrlKey || event.altKey || event.metaKey || composing || switching) return;
    event.preventDefault();
    if (!event.repeat) inputFormulaDollar();
  });
  editor.addEventListener('beforeinput', event => {
    if (event.cancelable && event.inputType === 'insertText' && event.data === '$' &&
        !composing && !event.isComposing && !switching && typeDollar()) event.preventDefault();
  });
  editor.addEventListener('input',()=>{
    captureRange();
    if(composing)return;
    historyPush();
    clearTimeout(renderTimer);
    renderTimer=setTimeout(render,110);
    updateCursor();
    changed();
  });
  ['click', 'keyup', 'select'].forEach(event => editor.addEventListener(event, () => {
    if (document.activeElement === editor.element) {
      captureRange();
      const pair = emptyFormulaPair();
      if (pair && (savedRange.start <= pair.start || savedRange.end >= pair.end)) discardEmptyFormula();
    }
    updateCursor();
  }));
  $('#doc-title').addEventListener('input',()=>{render();changed();});
  function changeLibrarySource() {
    clearTimeout(searchTimer);
    void loadLibrary();
  }
  function searchLibrary(event) {
    if (!library || event.isComposing) return;
    if (localSource()) {
      renderLibrary();
      return;
    }
    library.request++;
    library.rows = [];
    library.nextStart = null;
    library.loading = true;
    library.error = '';
    renderLibrary();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadLibrary, 180);
  }
  $('#library-search').addEventListener('input', searchLibrary);
  $('#library-search').addEventListener('compositionend', searchLibrary);
  $('#library-source').addEventListener('change', () => {
    void collectionPicker.reset();
    changeLibrarySource();
  });
  $('#library-sort').addEventListener('change', changeLibrarySource);
  window.addEventListener('resize', () => {
    if (!library) return;
    library.anchor = citationAnchor(library.range);
    placeLibrary();
  });
  $('#font-size').addEventListener('change',e=>editor.style.fontSize=e.target.value+'px');
  $('#numbering').addEventListener('change',()=>{render();changed();});
  $('#image-input').addEventListener('change', async event => {
    const file = event.target.files[0];
    const request = imageRequest;
    if (!file || !request) return;
    try {
      const { data } = await readImage(file);
      if (imageRequest !== request || documentId !== request.documentId) return;
      if (editor.value !== request.text) {
        toast('正文已改动，请重新选定位置后插入图片');
        return;
      }
      const resourceBytes = [...assets.values()].reduce((sum, item) => sum + item.data.length, data.length)
        + [...refMap.values()].reduce((sum, item) => sum + item.bib.length, 0);
      if (assets.size >= maxImages || resourceBytes > maxProjectResources) {
        toast('工程图片或资源达到上限，请改用较小的图片');
        return;
      }
      const id = 'image-' + crypto.randomUUID();
      const caption = file.name.replace(/\.[^.]+$/, '').replace(/[\[\]\x00-\x1f]/g, ' ');
      const marker = '![' + caption + '](asset:' + id + ')';
      if (editor.value.length - (request.range.end - request.range.start) + marker.length + 4 > editor.maxLength) {
        toast('正文长度达到上限，无法插入图片');
        return;
      }
      assets.set(id, { id, name: file.name, data });
      savedRange = request.range;
      insertText(marker, { block: true });
      toast('图片已加入工程');
    } catch (error) {
      if (imageRequest === request) toast(error.message || '读取图片失败，请重新选择');
    } finally {
      if (imageRequest === request) imageRequest = null;
    }
  });
  document.addEventListener('keydown',e=>{
    const modal=$('.overlay.open'),context=$('#context-menu.open');
    if(e.key==='Escape'){if(document.activeElement===editor.element)discardEmptyFormula();if(modal)closeOverlay();else if(context){closeContext();editor.focus();editor.setSelectionRange(savedRange.start,savedRange.end);}else{const trigger=$('[data-pop][aria-expanded="true"]');closeMenus();if(trigger)trigger.focus();}return;}
    if (e.key === 'Enter' && !e.isComposing && ['new-title', 'chapter-title'].includes(e.target.id)) {
      e.preventDefault();
      void action(e.target.id === 'new-title' ? 'create-document' : 'create-chapter');
      return;
    }
    if (modal?.id === 'library-overlay' && !e.isComposing && ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
      const active = document.activeElement;
      const search = $('#library-search');
      const entries = $$('#reference-list button:not(:disabled)');
      if (entries.length && (active === search || (active.matches('[data-cite]') && e.key !== 'Enter'))) {
        e.preventDefault();
        if (e.key === 'Enter') entries[0].click();
        else {
          const index = entries.indexOf(active);
          const next = index < 0 ? (e.key === 'ArrowUp' ? entries.length - 1 : 0) :
            (index + entries.length + (e.key === 'ArrowUp' ? -1 : 1)) % entries.length;
          entries[next].focus();
        }
        return;
      }
    }
    if(e.key==='Tab'&&modal){const focusable=$$('button:not(:disabled),input,select,textarea,summary',modal).filter(el=>el.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}return;}
    if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='c'&&!modal){e.preventDefault();captureRange();openLibrary();return;}
    if(!modal&&!composing&&!e.isComposing){
      const key=e.key.toLowerCase();
      const shortcut=(e.ctrlKey||e.metaKey)?({n:'new',o:'open',s:e.shiftKey?'save-as':'save'})[key]:e.key==='F5'?'refresh':null;
      if(shortcut){e.preventDefault();void action(shortcut);return;}
    }
    if(document.activeElement!==editor.element||composing||e.isComposing)return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'Equal' || e.key === '=')) {
      e.preventDefault();
      if (!e.repeat) startFormula();
      return;
    }
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.shiftKey && finishFormula()) {
      e.preventDefault();
      return;
    }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();restoreHistory(e.shiftKey?1:-1);return;}
    if(e.ctrlKey&&e.key.toLowerCase()==='y'){e.preventDefault();restoreHistory(1);return;}
    if(e.ctrlKey&&e.altKey&&/^Digit[0-6]$/.test(e.code)){e.preventDefault();captureRange();setHeading(Number(e.code.slice(-1)));return;}
    if(e.altKey&&!e.ctrlKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();captureRange();setHeading(Math.max(0,Math.min(6,lineInfo().level+(e.key==='ArrowLeft'?-1:1))));return;}
    if(e.shiftKey&&e.key==='F10'){e.preventDefault();const r=editor.getBoundingClientRect();showContext(r.left+20,r.top+40);$('#context-menu button').focus();}
  });
  if(innerWidth<=800){$('#sidebar').classList.add('closed');$('#sidebar-toggle').setAttribute('aria-expanded','false');}
  void initialize();
})();
