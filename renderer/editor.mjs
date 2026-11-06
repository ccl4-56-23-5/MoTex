import {
  Annotation, Compartment, Decoration, EditorState, EditorView, MatchDecorator,
  ViewPlugin, WidgetType, defaultKeymap, keymap, lineNumbers, placeholder,
} from './vendor/codemirror.mjs';

class CaptionWidget extends WidgetType {
  constructor(caption) {
    super();
    this.caption = caption || '图片';
  }

  eq(other) {
    return other.caption === this.caption;
  }

  toDOM(view) {
    const label = view.dom.ownerDocument.createElement('span');
    label.className = 'moye-image-caption';
    label.textContent = this.caption;
    return label;
  }
}

const captions = new MatchDecorator({
  regexp: /^[ \t]*!\[([^\]]*)\]\(asset:[A-Za-z0-9_-]+\)[ \t]*$/g,
  decoration: match => Decoration.replace({ widget: new CaptionWidget(match[1]) }),
});

const captionPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = captions.createDeco(view);
  }

  update(update) {
    this.decorations = captions.updateDeco(update, this.decorations);
  }
}, {
  decorations: plugin => plugin.decorations,
  provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.decorations ?? Decoration.none),
});

const programmatic = Annotation.define();

export function createEditor(textarea) {
  const host = textarea.ownerDocument.createElement('div');
  host.className = 'moye-editor';
  const attributes = { id: textarea.id, spellcheck: 'false', autocapitalize: 'off' };
  for (const attribute of textarea.attributes) {
    if (attribute.name.startsWith('aria-')) attributes[attribute.name] = attribute.value;
  }
  const maxLength = textarea.maxLength;
  const readOnly = new Compartment();
  const editability = value => EditorState.readOnly.of(value);
  let cachedDoc;
  let cachedText;
  textarea.replaceWith(host);

  const view = new EditorView({
    doc: textarea.value,
    parent: host,
    extensions: [
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(attributes),
      placeholder(textarea.placeholder),
      readOnly.of(editability(textarea.readOnly)),
      keymap.of(defaultKeymap),
      captionPlugin,
      EditorState.transactionFilter.of(transaction => {
        if (!transaction.docChanged || maxLength < 0 || transaction.newDoc.length <= maxLength) return transaction;
        return [];
      }),
      EditorView.updateListener.of(update => {
        if (!update.transactions.some(transaction => !transaction.annotation(programmatic))) return;
        if (update.docChanged) update.view.contentDOM.dispatchEvent(new Event('moye-input'));
        if (update.selectionSet || update.docChanged) {
          queueMicrotask(() => update.view.contentDOM.dispatchEvent(new Event('moye-select')));
        }
      }),
    ],
  });

  const dispatch = transaction => view.dispatch({ ...transaction, annotations: programmatic.of(true) });
  const position = value => Math.min(view.state.doc.length, Math.max(0, value));

  return {
    element: view.contentDOM,
    style: host.style,
    maxLength,
    get value() {
      if (view.state.doc !== cachedDoc) {
        cachedDoc = view.state.doc;
        cachedText = cachedDoc.toString();
      }
      return cachedText;
    },
    set value(text) { dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    set readOnly(value) { dispatch({ effects: readOnly.reconfigure(editability(Boolean(value))) }); },
    setSelectionRange(start, end) { dispatch({ selection: { anchor: position(start), head: position(end) } }); },
    setRangeText(text, from, to, mode = 'end') {
      const end = from + text.length;
      dispatch({ changes: { from, to, insert: text }, selection: { anchor: mode === 'select' ? from : end, head: end } });
    },
    addEventListener(type, listener) {
      const event = type === 'input' || type === 'select' ? 'moye-' + type : type;
      view.contentDOM.addEventListener(event, listener);
    },
    focus(options) { view.contentDOM.focus(options); },
    getBoundingClientRect() { return view.scrollDOM.getBoundingClientRect(); },
    coordsAtPos(pos) { return view.coordsAtPos(position(pos), 1); },
    scrollIntoView(pos) { dispatch({ effects: EditorView.scrollIntoView(position(pos), { y: 'center' }) }); },
  };
}
