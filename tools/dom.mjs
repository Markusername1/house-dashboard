/** Just enough DOM to run index.html's renderers in Node. Dev only. */
export class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attrs = {};
    this.style = new Proxy({}, { get: (t, k) => t[k] || '', set: (t, k, v) => (t[k] = v, true) });
    this._class = '';
    this.offsetHeight = 0;
    this.classList = {
      add: (...c) => { this._class = [...new Set(this._class.split(' ').filter(Boolean).concat(c))].join(' '); },
      contains: (c) => this._class.split(' ').includes(c),
    };
  }
  get className() { return this._class; }
  set className(v) { this._class = v || ''; }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(n) { this.childNodes.push(n); return n; }
  querySelector() { return null; }
  addEventListener() {}
  get textContent() {
    return this.childNodes.map((n) => (n instanceof El ? n.textContent : n.data)).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '') this.childNodes.push({ data: String(v) });
  }
}

export function makeDocument(ids) {
  const registry = {};
  for (const id of ids) registry[id] = new El('div');
  return {
    registry,
    document: {
      createElement: (t) => new El(t),
      createTextNode: (d) => ({ data: String(d) }),
      getElementById: (id) => registry[id] || null,
      querySelector: () => null,
      addEventListener: () => {},
      get hidden() { return false; },
      set title(v) { registry.__title = v; },
    },
  };
}

/** Indented text dump, so a render can be eyeballed in a terminal. */
export function dump(node, depth = 0) {
  const pad = '  '.repeat(depth);
  let out = '';
  for (const n of node.childNodes) {
    if (!(n instanceof El)) continue;   /* text prints on its owner's line */
    const cls = n.className ? `.${n.className.split(' ').join('.')}` : '';
    const own = n.childNodes.filter((c) => !(c instanceof El)).map((c) => c.data).join('').trim();
    out += `${pad}<${n.tagName.toLowerCase()}${cls}>${own ? ' ' + own : ''}\n`;
    out += dump(n, depth + 1);
  }
  return out;
}
