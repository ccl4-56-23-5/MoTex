import {
  Annotation, Compartment, Decoration, EditorState, EditorView, MatchDecorator,
  ViewPlugin, WidgetType, defaultKeymap, keymap, lineNumbers, placeholder,
} from './vendor/codemirror.mjs';
import { imagePattern } from './formula-structure.mjs';

class CaptionWidget extends WidgetType {
  constructor(match, maxLength) {
    super();
    this.marker = match[0];
    this.caption = match[1];
    this.maxLength = maxLength;
  }

  eq(other) {
    return other.marker === this.marker;
  }

  toDOM(view) {
    const document = view.dom.ownerDocument;
    const widget = document.createElement('span');
    widget.className = 'moye-caption-widget';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'moye-image-caption';
    button.textContent = this.caption || '图片';
    button.title = '编辑图片题注';
    button.setAttribute('aria-label', '编辑图片题注 ' + button.textContent);
    button.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) button.click();
    });
    button.addEventListener('click', () => {
      if (view.state.readOnly) return;
      const input = document.createElement('input');
      input.className = 'moye-caption-input';
      input.type = 'text';
      input.value = this.caption;
      input.placeholder = '图片题注';
      input.spellcheck = false;
      input.setAttribute('aria-label', '图片题注');
      if (this.maxLength >= 0) {
        input.maxLength = Math.max(0, this.maxLength - view.state.doc.length + this.caption.length);
      }

      let editing = true;
      let composing = false;
      const finish = (save, focusEditor) => {
        if (!editing) return;
        editing = false;
        if (!widget.isConnected) return;
        const start = view.posAtDOM(widget);
        const end = start + this.marker.length;
        widget.replaceChildren(button);
        if (view.state.doc.sliceString(start, end) !== this.marker) return;
        const caption = input.value.replace(/[\u0000-\u001f]/g, ' ');
        if (save && !view.state.readOnly && caption !== this.caption) {
          const from = start + this.marker.indexOf('![') + 2;
          view.dispatch({
            changes: { from, to: from + this.caption.length, insert: caption },
            selection: focusEditor ? { anchor: end + caption.length - this.caption.length } : undefined,
            userEvent: 'input.caption',
          });
        }
        view.requestMeasure();
        if (focusEditor) {
          if (save) view.focus();
          else button.focus({ preventScroll: true });
        }
      };

      input.addEventListener('compositionstart', event => {
        composing = true;
        event.stopPropagation();
      });
      input.addEventListener('compositionend', event => {
        composing = false;
        event.stopPropagation();
      });
      input.addEventListener('beforeinput', event => event.stopPropagation());
      input.addEventListener('keydown', event => {
        if (composing || event.isComposing || event.keyCode === 229) {
          event.stopPropagation();
          return;
        }
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.stopPropagation();
        event.preventDefault();
        finish(event.key === 'Enter', true);
      });
      input.addEventListener('blur', () => finish(true, false));
      widget.replaceChildren(input);
      input.focus({ preventScroll: true });
      input.setSelectionRange(this.caption.length, this.caption.length);
      view.requestMeasure();
    });
    widget.append(button);
    return widget;
  }
}

function editableCaptions(maxLength) {
  const captions = new MatchDecorator({
    regexp: new RegExp(imagePattern.source, 'g'),
    decoration: match => Decoration.replace({ widget: new CaptionWidget(match, maxLength) }),
  });

  return ViewPlugin.fromClass(class {
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
}

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
      editableCaptions(maxLength),
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
    commitCaption() {
      const active = view.dom.ownerDocument.activeElement;
      if (active?.classList.contains('moye-caption-input') && view.contentDOM.contains(active)) active.blur();
    },
    getBoundingClientRect() { return view.scrollDOM.getBoundingClientRect(); },
    coordsAtPos(pos) { return view.coordsAtPos(position(pos), 1); },
    scrollIntoView(pos) { dispatch({ effects: EditorView.scrollIntoView(position(pos), { y: 'center' }) }); },
    requestMeasure() { view.requestMeasure(); },
  };
}
