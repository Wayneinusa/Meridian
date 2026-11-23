// Code that runs inside the page: a compact, numbered view of what is on it
// (the model acts on "[12] button Sign in" instead of guessing pixels),
// finding a numbered element on screen, filling selects, and extracting
// text, tables and links. The same code serves Chromium and Firefox.

export interface RefInfo {
  tag: string;
  type?: string;
  role?: string;
  name: string;
  password?: boolean;
  payment?: boolean;
  submit?: boolean;
  inForm?: boolean;
  download?: boolean;
  href?: string;
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  refs: Record<string, RefInfo>;
  /** how far down the page the view is, in percent */
  scrolled: number;
}

/** Defines window.__mer once per document. */
const PAGE_LIB = String.raw`
(() => {
  if (window.__mer) return;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const BLOCK = /^(P|LI|TD|TH|DT|DD|H[1-6]|BLOCKQUOTE|PRE|FIGCAPTION|CAPTION|LABEL|LEGEND|ARTICLE|SECTION|DIV|MAIN|HEADER|FOOTER|NAV|ASIDE|FORM|TR|UL|OL|TABLE|BODY)$/;
  const PAYMENT = /cc-|card|cvc|cvv|csc|expir|iban|routing|account.?number/i;
  let refs = new Map();
  let next = 1;
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.02;
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '); if (clean(t)) return clean(t); }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.innerText)) return clean(l.innerText); }
    const wrap = el.closest('label'); if (wrap && wrap !== el && clean(wrap.innerText)) return clean(wrap.innerText).slice(0, 80);
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt.slice(0, 100);
    const img = el.querySelector && el.querySelector('img[alt]'); if (img) return clean(img.alt);
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.value || '').slice(0, 80);
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); return ['submit','button','reset','image'].includes(ty) ? 'button' : ty === 'checkbox' || ty === 'radio' ? ty : 'input'; }
    if (t === 'select') return 'select';
    if (t === 'textarea') return 'textarea';
    if (el.isContentEditable) return 'textbox';
    return t === 'summary' ? 'button' : t;
  };
  const infoOf = (el) => {
    const t = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = el.getAttribute('autocomplete') || '';
    const label = [el.getAttribute('name'), el.id, ac, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
    const form = el.closest('form');
    const submit = (t === 'button' && (type === 'submit' || (!type && !!form))) || (t === 'input' && (type === 'submit' || type === 'image'));
    return { tag: t, type: type || undefined, role: roleOf(el), name: nameOf(el), password: type === 'password' || undefined, payment: (t === 'input' && PAYMENT.test(label)) || undefined,
      submit: submit || undefined, inForm: !!form || undefined, download: (t === 'a' && el.hasAttribute('download')) || undefined, href: t === 'a' ? el.href : undefined };
  };
  const line = (n, el, info) => {
    let s = '[' + n + '] ' + info.role;
    if (info.name) s += ' "' + info.name + '"';
    if (info.tag === 'input' || info.tag === 'textarea') {
      if (info.type && info.type !== 'text') s += ' type=' + info.type;
      if (info.type === 'checkbox' || info.type === 'radio') s += el.checked ? ' (checked)' : ' (not checked)';
      else if (info.password) s += el.value ? ' value=••••' : '';
      else if (el.value) s += ' value="' + clean(el.value).slice(0, 60) + '"';
      if (el.placeholder && el.placeholder !== info.name) s += ' placeholder="' + clean(el.placeholder) + '"';
      if (el.disabled) s += ' (disabled)';
    } else if (info.tag === 'select') {
      const opts = [...el.options].map((o) => (o.selected ? '*' : '') + clean(o.text)).slice(0, 15);
      s += ' options: ' + opts.join(' | ');
    } else if (info.tag === 'a' && info.href && !/^javascript:/.test(info.href)) {
      s += ' -> ' + info.href.slice(0, 120);
    }
    if (info.submit) s += ' (submits form)';
    return s;
  };
  window.__mer = {
    snapshot(maxChars) {
      refs = new Map(); next = 1;
      document.querySelectorAll('[data-mer-ref]').forEach((e) => e.removeAttribute('data-mer-ref'));
      const out = []; const meta = {};
      let block = null; let buf = '';
      const flush = () => { const t = clean(buf); if (t) { const h = block && /^H([1-6])$/.exec(block.tagName); out.push(h ? '#'.repeat(Number(h[1])) + ' ' + t : t); } buf = ''; };
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === 1) {
            const el = node;
            if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME)$/.test(el.tagName)) return NodeFilter.FILTER_REJECT;
            if (!visible(el) && !el.matches('option')) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let len = 0;
      for (let node = walker.nextNode(); node && len < maxChars; node = walker.nextNode()) {
        if (node.nodeType === 1) {
          const el = node;
          if (el.matches(INTERACTIVE) && !el.closest('[data-mer-ref]')) {
            flush();
            const n = next++; el.setAttribute('data-mer-ref', String(n)); refs.set(n, el);
            const info = infoOf(el); meta[n] = info;
            const l = line(n, el, info); out.push(l); len += l.length;
          }
          continue;
        }
        const parent = node.parentElement;
        if (!parent || parent.closest('[data-mer-ref]')) continue;
        let b = parent; while (b && !BLOCK.test(b.tagName)) b = b.parentElement;
        if (b !== block) { flush(); block = b; }
        buf += ' ' + node.textContent; if (buf.length > 600) { len += buf.length; flush(); }
      }
      flush();
      let text = out.join('\n');
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n… (page continues: scroll or use extract)';
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      return { url: location.href, title: document.title, text, refs: meta, scrolled: Math.round((scrollY / max) * 100) };
    },
    locate(n) {
      const el = refs.get(n) || document.querySelector('[data-mer-ref="' + n + '"]');
      if (!el || !el.isConnected) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, info: infoOf(el) };
    },
    focusAndClear(n) {
      const el = refs.get(n) || document.querySelector('[data-mer-ref="' + n + '"]');
      if (!el) return false;
      el.focus();
      if (el.select) el.select(); else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
      return true;
    },
    select(n, value) {
      const el = refs.get(n) || document.querySelector('[data-mer-ref="' + n + '"]');
      if (!el || el.tagName !== 'SELECT') return 'not a select';
      const want = String(value).toLowerCase();
      const opt = [...el.options].find((o) => o.value.toLowerCase() === want || clean(o.text).toLowerCase() === want) || [...el.options].find((o) => clean(o.text).toLowerCase().includes(want));
      if (!opt) return 'no option ' + value;
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'selected ' + clean(opt.text);
    },
    extract(maxChars) {
      const root = document.querySelector('main, article, [role=main]') || document.body;
      const text = clean(root.innerText).slice(0, maxChars);
      const tables = [...document.querySelectorAll('table')].slice(0, 10).map((t) => [...t.rows].slice(0, 60).map((r) => [...r.cells].map((c) => clean(c.innerText).slice(0, 200))));
      const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 200).map((a) => ({ text: clean(a.innerText).slice(0, 100), href: a.href }));
      return { url: location.href, title: document.title, text, tables, links };
    },
  };
})();
`;

/** An expression that returns JSON text (works the same through CDP and BiDi). */
export function pageCall(body: string): string {
  return `(async () => { ${PAGE_LIB}; const __r = await (async () => { ${body} })(); return JSON.stringify(__r === undefined ? null : __r); })()`;
}

export const snapshotCall = (maxChars: number) => pageCall(`return window.__mer.snapshot(${maxChars});`);
export const locateCall = (ref: number) => pageCall(`return window.__mer.locate(${ref});`);
export const focusCall = (ref: number) => pageCall(`return window.__mer.focusAndClear(${ref});`);
export const selectCall = (ref: number, value: string) => pageCall(`return window.__mer.select(${ref}, ${JSON.stringify(value)});`);
export const extractCall = (maxChars: number) => pageCall(`return window.__mer.extract(${maxChars});`);
