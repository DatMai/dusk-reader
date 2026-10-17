// Dusk Reader: content script (runs at document_start in every frame).
//
// Dynamic mode: reads every CSS rule on the page, recomputes each color by its role
// (background / text / border) and inserts an override <style> right after the source
// stylesheet so the cascade order is preserved. CSS variables are split into three copies,
// --dusk-bg--x / --dusk-fg--x / --dusk-border--x, and every var(--x) points to the copy
// that matches its role.
//
// Filter mode: inverts and hue-rotates the whole page, then reverts images and videos.

(() => {
  'use strict';
  if (window.__duskReader) return;
  window.__duskReader = true;

  const DEFAULTS = {
    enabled: true,
    mode: 'dynamic',
    brightness: 100,
    contrast: 100,
    sepia: 0,
    grayscale: 0,
    bg: '#181a1b',
    text: '#e8e6e3',
    detectDark: true,
    disabledSites: [],
  };

  const IS_TOP = window === window.top;
  const HOST = location.hostname;
  const ATTR = 'data-dusk';
  const INLINE_ATTR = 'data-dusk-i';
  const ROLES = ['bg', 'fg', 'border'];
  const INLINE_SEL = '[style],[bgcolor],font[color],svg [fill],svg [stroke],svg [stop-color]';

  let settings = { ...DEFAULTS };
  let active = false;
  let darkDetected = false;
  let status = { active: false, reason: 'loading' };

  // ---------------------------------------------------------------- color

  const NAMED = new Set((
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet ' +
    'brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue ' +
    'darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange ' +
    'darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise ' +
    'darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia ' +
    'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ' +
    'ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue ' +
    'lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
    'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red ' +
    'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue ' +
    'slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen canvas canvastext buttonface buttontext field fieldtext'
  ).split(' '));

  const COLOR_TOKEN =
    /(?<![\w-])#[0-9a-f]{3,8}(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|(?<![\w-])[a-z]+(?![\w-])/gi;
  const TRIPLET = /^\s*(\d{1,3})(\s*,\s*|\s+)(\d{1,3})\2(\d{1,3})\s*$/;

  // Parse colors with a canvas: the browser understands hex, rgb, hsl, named colors, oklch...
  const ctx = (typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(1, 1)
    : document.createElement('canvas')).getContext('2d');
  const parseCache = new Map();

  function parseColor(str) {
    const key = str.trim().toLowerCase();
    if (parseCache.has(key)) return parseCache.get(key);
    let rgb = null;
    if (key && key !== 'transparent' && key !== 'currentcolor' && !key.includes('var(')) {
      ctx.fillStyle = '#010203';
      ctx.fillStyle = key;
      const a = ctx.fillStyle;
      ctx.fillStyle = '#040506';
      ctx.fillStyle = key;
      if (a === ctx.fillStyle) rgb = fromCanvas(a);
    }
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(key, rgb);
    return rgb;
  }

  function fromCanvas(s) {
    if (s[0] === '#') {
      return { r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16), a: 1 };
    }
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function rgbToHsl({ r, g, b, a }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l, a };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l, a };
  }

  function hslToRgb({ h, s, l, a }) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v, a };
    }
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
      h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255), a };
  }

  const lerp = (x, inLo, inHi, outLo, outHi) => ((x - inLo) * (outHi - outLo)) / (inHi - inLo) + outLo;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  let poleBg = rgbToHsl({ r: 24, g: 26, b: 27, a: 1 });
  let poleFg = rgbToHsl({ r: 232, g: 230, b: 227, a: 1 });

  // Background: light becomes dark (white → chosen background), dark stays dark.
  function mapBg({ h, s, l, a }) {
    const dark = l < 0.5;
    const neutral = s < 0.12 || (l > 0.8 && h > 200 && h < 280);
    let nl = dark ? lerp(l, 0, 0.5, 0, 0.4) : lerp(l, 0.5, 1, 0.4, poleBg.l);
    if (neutral) return { h: poleBg.h, s: poleBg.s, l: nl, a };
    let nh = h;
    if (!dark) {
      if (h > 60 && h < 180) nh = h > 120 ? lerp(h, 120, 180, 135, 180) : lerp(h, 60, 120, 60, 105);
      if (nh > 40 && nh < 80) nl *= 0.75; // bright yellow/orange turns muddy brown, so darken it more
    }
    return { h: nh, s, l: nl, a };
  }

  // Text: dark becomes light (black → chosen text color), never darker than 0.55.
  function mapFg({ h, s, l, a }) {
    const MIN = 0.55;
    const neutral = l < 0.2 || s < 0.24;
    const blue = !neutral && h > 205 && h < 245;
    const nh = neutral ? poleFg.h : blue ? lerp(h, 205, 245, 205, 220) : h;
    const ns = neutral ? poleFg.s : s;
    let nl;
    if (l > 0.5) nl = lerp(l, 0.5, 1, MIN, poleFg.l);
    else nl = lerp(l, 0, 0.5, poleFg.l, blue ? Math.min(1, MIN + 0.05) : MIN);
    return { h: nh, s: ns, l: nl, a };
  }

  function mapBorder({ h, s, l, a }) {
    const neutral = l < 0.2 || s < 0.24;
    const pole = l < 0.5 ? poleFg : poleBg;
    return { h: neutral ? pole.h : h, s: neutral ? pole.s : s, l: lerp(l, 0, 1, 0.5, 0.2), a };
  }

  // Brightness → contrast → grayscale → sepia, matching the CSS filter order.
  function adjust(rgb) {
    let r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const { brightness, contrast, grayscale, sepia } = settings;
    if (brightness !== 100) { const v = brightness / 100; r *= v; g *= v; b *= v; }
    if (contrast !== 100) { const v = contrast / 100; r = (r - 0.5) * v + 0.5; g = (g - 0.5) * v + 0.5; b = (b - 0.5) * v + 0.5; }
    if (grayscale !== 0) {
      const v = grayscale / 100;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r += (y - r) * v; g += (y - g) * v; b += (y - b) * v;
    }
    if (sepia !== 0) {
      const v = sepia / 100;
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * v; g += (sg - g) * v; b += (sb - b) * v;
    }
    return { r: Math.round(clamp01(r) * 255), g: Math.round(clamp01(g) * 255), b: Math.round(clamp01(b) * 255), a: rgb.a };
  }

  const modCache = new Map();
  function modColor(rgb, role) {
    const key = `${role}${rgb.r},${rgb.g},${rgb.b},${rgb.a}`;
    let out = modCache.get(key);
    if (out) return out;
    const hsl = rgbToHsl(rgb);
    const mapped = role === 'bg' ? mapBg(hsl) : role === 'fg' ? mapFg(hsl) : mapBorder(hsl);
    const c = adjust(hslToRgb(mapped));
    out = c.a === 1
      ? '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')
      : `rgba(${c.r}, ${c.g}, ${c.b}, ${+c.a.toFixed(3)})`;
    modCache.set(key, out);
    return out;
  }

  const modHex = (hex, role) => modColor(parseColor(hex), role);

  // ---------------------------------------------------------------- CSS value transforms

  function modColorsInPlain(seg, role) {
    return seg.replace(COLOR_TOKEN, (tok) => {
      if (/^[a-z]+$/i.test(tok) && !NAMED.has(tok.toLowerCase())) return tok;
      const rgb = parseColor(tok);
      return rgb ? modColor(rgb, role) : tok;
    });
  }

  function matchParen(str, open) {
    let depth = 0;
    for (let i = open; i < str.length; i++) {
      const ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return i;
    }
    return -1;
  }

  function topLevelComma(str) {
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) return i;
    }
    return -1;
  }

  const roleVar = (role, name) => `--dusk-${role}${name}`;

  function absolutize(inner, base) {
    const raw = inner.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (/^(data:|blob:|[a-z][\w+.-]*:\/\/|#)/i.test(raw)) return inner;
    try {
      return JSON.stringify(new URL(raw, base).href);
    } catch {
      return inner;
    }
  }

  function nextFn(value, name, from) {
    let i = value.indexOf(name, from);
    while (i > 0 && /[\w-]/.test(value[i - 1])) i = value.indexOf(name, i + 1);
    return i;
  }

  // Recolor every color in a CSS value for a role; var(--x) → var(--dusk-<role>--x, var(--x, ...)).
  function transform(value, role, base) {
    let out = '';
    let i = 0;
    while (i < value.length) {
      const v = nextFn(value, 'var(', i);
      const u = nextFn(value, 'url(', i);
      const next = v < 0 ? u : u < 0 ? v : Math.min(u, v);
      if (next < 0) {
        out += modColorsInPlain(value.slice(i), role);
        break;
      }
      out += modColorsInPlain(value.slice(i, next), role);
      const end = matchParen(value, next + 3);
      if (end < 0) {
        out += value.slice(next);
        break;
      }
      const inner = value.slice(next + 4, end);
      if (next === v) {
        const comma = topLevelComma(inner);
        const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
        const fb = comma < 0 ? '' : ',' + transform(inner.slice(comma + 1), role, base);
        out += `var(${roleVar(role, name)}, var(${name}${fb}))`;
      } else {
        out += `url(${absolutize(inner, base)})`;
      }
      i = end + 1;
    }
    return out;
  }

  // A CSS variable may be used as background or text, so emit all three copies.
  function varDecls(name, value, base, imp) {
    const v = value.trim();
    let out = '';
    const rgb = /[\s,(]/.test(v) && !/^(rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\(/i.test(v) ? null : parseColor(v);
    if (rgb) {
      for (const role of ROLES) out += `${roleVar(role, name)}:${modColor(rgb, role)}${imp};`;
      return out;
    }
    const t = TRIPLET.exec(v);
    if (t) {
      const src = { r: +t[1], g: +t[3], b: +t[4], a: 1 };
      for (const role of ROLES) {
        const c = parseColor(modColor(src, role));
        out += `${roleVar(role, name)}:${c.r}${t[2]}${c.g}${t[2]}${c.b}${imp};`;
      }
      return out;
    }
    if (v.includes('var(') || transform(v, 'bg', base) !== v) {
      for (const role of ROLES) out += `${roleVar(role, name)}:${transform(v, role, base)}${imp};`;
    }
    return out;
  }

  function roleOf(prop) {
    if (prop === 'scrollbar-color') return 'border';
    if (prop.includes('shadow') || prop.startsWith('background')) return 'bg';
    if (prop.startsWith('border') || prop.startsWith('outline') || prop === 'column-rule-color') {
      return prop.endsWith('color') ? 'border' : null;
    }
    if (prop === 'list-style-image') return 'bg';
    if (prop === 'color' || prop === 'fill' || prop === 'stroke' || prop.endsWith('-color')) return 'fg';
    return null;
  }

  function shorthandFor(style, prop) {
    const cands = prop.startsWith('background') ? ['background']
      : prop.startsWith('border') ? [prop.replace(/-color$/, ''), 'border-color', 'border']
      : prop.startsWith('outline') ? ['outline']
      : prop === 'text-decoration-color' ? ['text-decoration']
      : prop === 'column-rule-color' ? ['column-rule'] : [];
    for (const c of cands) {
      const val = style.getPropertyValue(c);
      if (val && val.includes('var(')) return c;
    }
    return null;
  }

  function hasMask(style) {
    const m = style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image');
    return !!m && m !== 'none' && !m.startsWith('linear-gradient');
  }

  function buildDecls(style, base, forceImportant) {
    let out = '';
    const doneShorthands = new Set();
    for (let i = 0; i < style.length; i++) {
      let prop = style[i];
      let value = style.getPropertyValue(prop);
      const imp = forceImportant || style.getPropertyPriority(prop) ? ' !important' : '';
      if (prop.startsWith('--')) {
        if (value) out += varDecls(prop, value, base, imp);
        continue;
      }
      let role = roleOf(prop);
      if (!role) continue;
      if (!value) {
        // shorthand containing var(): longhands read as empty, so handle the shorthand itself
        const sh = shorthandFor(style, prop);
        if (!sh || doneShorthands.has(sh)) continue;
        doneShorthands.add(sh);
        prop = sh;
        value = style.getPropertyValue(sh);
        if (sh.startsWith('border') || sh === 'outline' || sh === 'column-rule') role = 'border';
        else if (sh === 'text-decoration') role = 'fg';
      }
      if (prop === 'background-color' && hasMask(style)) role = 'fg'; // icon drawn with a mask
      if ((prop === 'background-image' || prop === 'list-style-image') && !/gradient|var\(/i.test(value)) continue;
      const nv = transform(value, role, base);
      if (nv !== value) out += `${prop}:${nv}${imp};`;
    }
    return out;
  }

  function groupHeader(r) {
    if (r instanceof CSSMediaRule) return `@media ${r.media.mediaText}`;
    if (r instanceof CSSSupportsRule) return `@supports ${r.conditionText}`;
    if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) return `@layer ${r.name}`;
    if (typeof CSSContainerRule !== 'undefined' && r instanceof CSSContainerRule) {
      return `@container ${r.containerName ? r.containerName + ' ' : ''}${r.containerQuery}`;
    }
    const t = r.cssText;
    return t.slice(0, t.indexOf('{')).trim();
  }

  function buildKeyframes(r, base) {
    let changed = false;
    let body = '';
    for (const kf of r.cssRules) {
      let decls = '';
      for (let i = 0; i < kf.style.length; i++) {
        const prop = kf.style[i];
        const value = kf.style.getPropertyValue(prop);
        const role = roleOf(prop);
        const nv = role ? transform(value, role, base) : value;
        if (nv !== value) changed = true;
        decls += `${prop}:${nv};`;
      }
      body += `${kf.keyText}{${decls}}`;
    }
    return changed ? `@keyframes ${CSS.escape(r.name)}{${body}}` : '';
  }

  function buildRules(rules, base) {
    let out = '';
    for (const r of rules) {
      try {
        if (r instanceof CSSStyleRule) {
          let body = buildDecls(r.style, base, false);
          if (r.cssRules && r.cssRules.length) body += buildRules(r.cssRules, base);
          if (body) out += `${r.selectorText}{${body}}`;
        } else if (r instanceof CSSImportRule) {
          if (!r.styleSheet) continue;
          const sub = buildRules(r.styleSheet.cssRules, r.styleSheet.href || base);
          if (sub) out += r.media && r.media.mediaText ? `@media ${r.media.mediaText}{${sub}}` : sub;
        } else if (typeof CSSNestedDeclarations !== 'undefined' && r instanceof CSSNestedDeclarations) {
          out += buildDecls(r.style, base, false);
        } else if (r instanceof CSSKeyframesRule) {
          out += buildKeyframes(r, base);
        } else if (r.cssRules) {
          const sub = buildRules(r.cssRules, base);
          if (sub) out += `${groupHeader(r)}{${sub}}`;
        }
      } catch {
        // cross-origin @import or an unusual rule: skip it and keep going
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- page stylesheets

  const managed = new Map(); // ownerNode → { node, sheet, len, cross }
  const adoptedOverrides = new WeakMap(); // source CSSStyleSheet → { sheet, len }
  const ourAdopted = new WeakSet();
  const roots = new Set(); // Document + open ShadowRoots
  const fetched = new Map();

  function isOurs(node) {
    return node && node.nodeType === 1 && node.hasAttribute(ATTR);
  }

  function makeStyle(kind) {
    const s = document.createElement('style');
    s.setAttribute(ATTR, kind);
    return s;
  }

  function wrapMedia(css, sheet) {
    const media = sheet.media && sheet.media.mediaText;
    return media && media !== 'all' ? `@media ${media}{${css}}` : css;
  }

  function writeOverride(owner, sheet, css, len, cross) {
    let entry = managed.get(owner);
    if (!css) {
      if (entry) entry.node.remove();
      managed.set(owner, { node: entry ? entry.node : makeStyle('sheet'), sheet, len, cross, empty: true });
      return;
    }
    if (!entry) entry = { node: makeStyle('sheet') };
    Object.assign(entry, { sheet, len, cross, empty: false });
    const text = wrapMedia(css, sheet);
    if (entry.node.textContent !== text) entry.node.textContent = text;
    if (owner.nextSibling !== entry.node && owner.parentNode) owner.after(entry.node);
    managed.set(owner, entry);
  }

  function processOwner(owner) {
    if (!active || isOurs(owner)) return;
    const sheet = owner.sheet;
    if (!sheet) {
      if (owner.localName === 'link' && !owner.__duskWait) {
        owner.__duskWait = true;
        owner.addEventListener('load', () => { owner.__duskWait = false; processOwner(owner); }, { once: true });
      }
      return;
    }
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      rules = null;
    }
    if (!rules) {
      processCrossOrigin(owner, sheet);
      return;
    }
    writeOverride(owner, sheet, buildRules(rules, sheet.href || document.baseURI), rules.length, false);
  }

  function processCrossOrigin(owner, sheet) {
    const href = sheet.href;
    if (!href || !chrome.runtime || !chrome.runtime.id) return;
    if (!fetched.has(href)) {
      fetched.set(href, chrome.runtime.sendMessage({ type: 'fetch-css', url: href })
        .then((r) => (r && r.text) || null)
        .catch(() => null));
    }
    fetched.get(href).then((text) => {
      if (!text || !active || owner.sheet !== sheet) return;
      const tmp = new CSSStyleSheet();
      try {
        tmp.replaceSync(text.replace(/@import[^;]+;/g, ''));
      } catch {
        return;
      }
      writeOverride(owner, sheet, buildRules(tmp.cssRules, href), -1, true);
    });
  }

  function processAdopted(root) {
    let list;
    try {
      list = root.adoptedStyleSheets;
    } catch {
      return;
    }
    if (!list || !list.length) return;
    const next = [];
    for (const s of list) {
      if (ourAdopted.has(s)) continue;
      next.push(s);
      let rules;
      try {
        rules = s.cssRules;
      } catch {
        continue;
      }
      let o = adoptedOverrides.get(s);
      if (!o || o.len !== rules.length) {
        const css = buildRules(rules, document.baseURI);
        if (!o) {
          o = { sheet: new CSSStyleSheet(), len: 0 };
          ourAdopted.add(o.sheet);
          adoptedOverrides.set(s, o);
        }
        o.sheet.replaceSync(css);
        o.len = rules.length;
      }
      next.push(o.sheet);
    }
    if (next.length !== list.length || next.some((s, i) => s !== list[i])) {
      try {
        root.adoptedStyleSheets = next;
      } catch {
        // sheet from another world; the browser refuses to mix them
      }
    }
  }

  // ---------------------------------------------------------------- style inline

  const inlineIds = new WeakMap();
  const inlineState = new Map(); // root → { node, rules: Map(id → css), timer }
  let inlineSeq = 0;

  function processInline(el) {
    if (!active || el.nodeType !== 1 || isOurs(el)) return;
    let decls = '';
    if (el.hasAttribute('style') && el.style) decls += buildDecls(el.style, document.baseURI, true);
    const bgAttr = el.getAttribute('bgcolor');
    if (bgAttr && parseColor(bgAttr)) decls += `background-color:${modColor(parseColor(bgAttr), 'bg')} !important;`;
    if (el.localName === 'font') {
      const c = el.getAttribute('color');
      if (c && parseColor(c)) decls += `color:${modColor(parseColor(c), 'fg')} !important;`;
    }
    if (el instanceof SVGElement) {
      for (const attr of ['fill', 'stroke', 'stop-color']) {
        const v = el.getAttribute(attr);
        const rgb = v && parseColor(v);
        if (rgb) decls += `${attr}:${modColor(rgb, 'fg')} !important;`;
      }
    }
    const root = el.getRootNode();
    let id = inlineIds.get(el);
    if (!decls && !id) return;
    const st = inlineFor(root);
    if (!st) return;
    if (!id) {
      id = String(++inlineSeq);
      inlineIds.set(el, id);
    }
    if (el.getAttribute(INLINE_ATTR) !== id) el.setAttribute(INLINE_ATTR, id);
    if (decls) st.rules.set(id, `[${INLINE_ATTR}="${id}"]{${decls}}`);
    else st.rules.delete(id);
    scheduleInlineFlush(root, st);
  }

  function inlineFor(root) {
    let st = inlineState.get(root);
    if (st) return st;
    if (root !== document && !(root instanceof ShadowRoot)) return null;
    st = { node: makeStyle('inline'), rules: new Map(), timer: 0 };
    inlineState.set(root, st);
    return st;
  }

  function scheduleInlineFlush(root, st) {
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = 0;
      if (!active) return;
      st.node.textContent = [...st.rules.values()].join('\n');
      const parent = root === document ? document.head || document.documentElement : root;
      if (parent && st.node.parentNode !== parent) parent.appendChild(st.node);
    }, 16);
  }

  // ---------------------------------------------------------------- images
  // Dark logos/icons on a transparent background vanish on a dark page, so invert them.
  // JPEGs have no transparency and large images are usually photos, so both are skipped.

  const IMG_ATTR = 'data-dusk-img';
  const imgVerdicts = new Map(); // url → Promise<'invert' | null>
  const MAX_IMG_SIDE = 512;

  function queueImage(img) {
    if (!active || img.localName !== 'img') return;
    if (!img.complete || !img.naturalWidth) {
      if (!img.__duskWait) {
        img.__duskWait = true;
        img.addEventListener('load', () => { img.__duskWait = false; queueImage(img); }, { once: true });
      }
      return;
    }
    const url = img.currentSrc || img.src;
    if (!url || /^data:image\/jpe?g|\.jpe?g(\?|#|$)/i.test(url)) return;
    if (img.naturalWidth > MAX_IMG_SIDE * 2 || img.naturalHeight > MAX_IMG_SIDE * 2) return;
    if (!imgVerdicts.has(url)) imgVerdicts.set(url, classifyImage(img, url).catch(() => null));
    imgVerdicts.get(url).then((v) => {
      if (!active || (img.currentSrc || img.src) !== url) return;
      if (v) img.setAttribute(IMG_ATTR, v);
      else img.removeAttribute(IMG_ATTR);
    });
  }

  async function classifyImage(img, url) {
    const size = 32;
    const pixels = (source) => {
      const c = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
      c.drawImage(source, 0, 0, size, size);
      return c.getImageData(0, 0, size, size).data;
    };
    let data;
    try {
      data = pixels(img);
    } catch {
      // a cross-origin image taints the canvas for good: fetch it via the background and use a fresh canvas
      if (!chrome.runtime || !chrome.runtime.id || !/^https?:/.test(url)) return null;
      const res = await chrome.runtime.sendMessage({ type: 'fetch-image', url });
      if (!res || !res.dataURL) return null;
      const copy = new Image();
      copy.src = res.dataURL;
      await copy.decode();
      data = pixels(copy);
    }
    let transparent = 0;
    let opaque = 0;
    let lightSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 25) {
        transparent++;
        continue;
      }
      opaque++;
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      lightSum += (max + min) / 510;
    }
    const total = transparent + opaque;
    if (!opaque || transparent / total < 0.1) return null;
    return lightSum / opaque < 0.35 ? 'invert' : null;
  }

  // ---------------------------------------------------------------- DOM scanning and observation

  const pendingOwners = new Set();
  const pendingInline = new Set();
  let flushTimer = 0;

  function queueOwner(n) { pendingOwners.add(n); scheduleFlush(); }
  function queueInline(n) { pendingInline.add(n); scheduleFlush(); }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      const owners = [...pendingOwners];
      const inl = [...pendingInline];
      pendingOwners.clear();
      pendingInline.clear();
      owners.forEach(processOwner);
      inl.forEach(processInline);
    }, 0);
  }

  const isStyleOwner = (n) =>
    n.localName === 'style' || (n.localName === 'link' && /(^|\s)stylesheet(\s|$)/i.test(n.rel || ''));

  function scanTree(node) {
    if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;
    if (node.nodeType === 1) {
      if (isOurs(node)) return;
      if (isStyleOwner(node)) queueOwner(node);
      if (node.matches(INLINE_SEL)) queueInline(node);
      if (node.localName === 'img') queueImage(node);
      if (node.shadowRoot) attachRoot(node.shadowRoot);
    }
    if (!node.querySelectorAll) return;
    node.querySelectorAll('style, link[rel~="stylesheet" i]').forEach((n) => isOurs(n) || queueOwner(n));
    node.querySelectorAll(INLINE_SEL).forEach(queueInline);
    node.querySelectorAll('img').forEach(queueImage);
    if (node.nodeType !== 1 || node.childElementCount) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (el.shadowRoot) attachRoot(el.shadowRoot);
      }
    }
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      const t = m.target;
      if (m.type === 'attributes') {
        if (isOurs(t) || m.attributeName === INLINE_ATTR) continue;
        if (isStyleOwner(t) && (m.attributeName === 'href' || m.attributeName === 'media' || m.attributeName === 'rel')) queueOwner(t);
        else if (m.attributeName === 'src' || m.attributeName === 'srcset') queueImage(t);
        else queueInline(t);
      } else if (m.type === 'characterData') {
        const p = t.parentNode;
        if (p && p.localName === 'style' && !isOurs(p)) queueOwner(p);
      } else {
        if (t.localName === 'style' && !isOurs(t)) queueOwner(t);
        m.addedNodes.forEach(scanTree);
        m.removedNodes.forEach((n) => {
          const e = managed.get(n);
          if (e) {
            e.node.remove();
            managed.delete(n);
          }
        });
      }
    }
  });

  function attachRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'bgcolor', 'color', 'fill', 'stroke', 'stop-color', 'href', 'media', 'rel', 'src', 'srcset'],
    });
    if (root !== document) {
      const base = makeStyle('base');
      base.textContent = baseCSS(true);
      root.prepend(base);
    }
    scanTree(root);
    processAdopted(root);
  }

  // CSS-in-JS using insertRule causes no mutations, so poll the rule counts.
  let pollTimer = 0;
  function poll() {
    if (!active || document.hidden) return;
    for (const [owner, e] of managed) {
      if (!owner.isConnected) {
        e.node.remove();
        managed.delete(owner);
        continue;
      }
      if (e.cross) continue;
      let len = -1;
      try {
        len = owner.sheet ? owner.sheet.cssRules.length : -1;
      } catch {
        len = -1;
      }
      if (owner.sheet !== e.sheet || len !== e.len) queueOwner(owner);
      else if (!e.empty && owner.nextSibling !== e.node && owner.parentNode) owner.after(e.node);
    }
    for (const root of roots) processAdopted(root);
    ensureBase();
  }

  // ---------------------------------------------------------------- base style

  let baseNode = null;

  function baseCSS(isShadow) {
    const bg = modHex('#ffffff', 'bg');
    const fg = modHex('#000000', 'fg');
    const border = modHex('#4c4c4c', 'border');
    const lines = [];
    if (!isShadow) {
      if (IS_TOP) lines.push(`html{background-color:${bg} !important;}`);
      lines.push('html{color-scheme:dark !important;}');
      lines.push(`html,body{background-color:${bg};}`);
      lines.push(`html,body{color:${fg};border-color:${border};}`);
      lines.push(`html{scrollbar-color:${modHex('#c1c1c1', 'border')} ${modHex('#f1f1f1', 'bg')};}`);
    }
    lines.push(`input,textarea,select,button,dialog{background-color:${bg};color:${fg};border-color:${border};}`);
    lines.push(`a{color:${modHex('#0000ee', 'fg')};}`);
    lines.push(`table{border-color:${modHex('#808080', 'border')};}`);
    lines.push(`mark{background-color:${modHex('#ffff00', 'bg')};color:${fg};}`);
    lines.push(`::placeholder{color:${modHex('#757575', 'fg')};}`);
    lines.push(`img[${IMG_ATTR}="invert"]{filter:invert(100%) hue-rotate(180deg) !important;}`);
    lines.push(`::selection{background-color:${modHex('#3390ff', 'bg')} !important;color:${modHex('#ffffff', 'fg')} !important;}`);
    return lines.join('\n');
  }

  function ensureBase() {
    const root = document.documentElement;
    if (!root) return;
    if (!baseNode) {
      baseNode = makeStyle('base');
      baseNode.textContent = baseCSS(false);
    }
    // placed before every page stylesheet so page CSS (and its overrides) wins
    if (baseNode.parentNode !== root || root.firstChild !== baseNode) root.prepend(baseNode);
  }

  // ---------------------------------------------------------------- Filter mode

  function filterCSS() {
    const f = ['invert(100%) hue-rotate(180deg)'];
    if (settings.brightness !== 100) f.push(`brightness(${settings.brightness}%)`);
    if (settings.contrast !== 100) f.push(`contrast(${settings.contrast}%)`);
    if (settings.grayscale) f.push(`grayscale(${settings.grayscale}%)`);
    if (settings.sepia) f.push(`sepia(${settings.sepia}%)`);
    return `@media screen {
html{filter:${f.join(' ')} !important;background:#fff !important;}
img,video,picture,canvas,embed,object,svg image,[style*="url("]{filter:invert(100%) hue-rotate(180deg) !important;}
:fullscreen,:fullscreen *{filter:none !important;}
}`;
  }

  // ---------------------------------------------------------------- detect pages that are already dark

  function luminance({ r, g, b }) {
    const ch = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  }

  function pageIsAlreadyDark() {
    if (!document.body) return false;
    const ours = [...document.querySelectorAll(`style[${ATTR}]`)];
    ours.forEach((s) => s.sheet && (s.sheet.disabled = true));
    const adopted = [];
    for (const s of document.adoptedStyleSheets || []) {
      if (ourAdopted.has(s)) { s.disabled = true; adopted.push(s); }
    }
    let result = false;
    try {
      const pick = [document.body, document.documentElement]
        .map((el) => parseColor(getComputedStyle(el).backgroundColor))
        .find((c) => c && c.a > 0.5);
      result = !!pick && luminance(pick) < 0.12;
    } finally {
      ours.forEach((s) => s.sheet && (s.sheet.disabled = false));
      adopted.forEach((s) => (s.disabled = false));
    }
    return result;
  }

  function checkDark() {
    if (!active || !IS_TOP || !settings.detectDark || darkDetected) return;
    if (pageIsAlreadyDark()) {
      darkDetected = true;
      teardown();
      status = { active: false, reason: 'already-dark' };
    }
  }

  // ---------------------------------------------------------------- enable / disable

  function teardown() {
    active = false;
    observer.disconnect();
    clearInterval(pollTimer);
    pollTimer = 0;
    for (const root of roots) {
      root.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
      root.querySelectorAll(`[${INLINE_ATTR}]`).forEach((n) => n.removeAttribute(INLINE_ATTR));
      root.querySelectorAll(`[${IMG_ATTR}]`).forEach((n) => n.removeAttribute(IMG_ATTR));
      try {
        const list = root.adoptedStyleSheets;
        if (list && list.some((s) => ourAdopted.has(s))) root.adoptedStyleSheets = list.filter((s) => !ourAdopted.has(s));
      } catch {
        // ignore
      }
    }
    document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
    roots.clear();
    managed.clear();
    inlineState.clear();
    pendingOwners.clear();
    pendingInline.clear();
    baseNode = null;
    modCache.clear();
  }

  function shouldRun() {
    return settings.enabled && !settings.disabledSites.includes(HOST) && !(darkDetected && settings.detectDark);
  }

  function apply() {
    teardown();
    if (!shouldRun()) {
      status = {
        active: false,
        reason: darkDetected && settings.detectDark ? 'already-dark' : !settings.enabled ? 'off' : 'site-off',
      };
      return;
    }
    const pb = parseColor(settings.bg);
    const pf = parseColor(settings.text);
    if (pb) poleBg = rgbToHsl(pb);
    if (pf) poleFg = rgbToHsl(pf);
    active = true;
    status = { active: true, reason: settings.mode };

    if (settings.mode === 'filter') {
      if (!IS_TOP) return;
      baseNode = makeStyle('filter');
      baseNode.textContent = filterCSS();
      document.documentElement.prepend(baseNode);
      return;
    }
    ensureBase();
    attachRoot(document);
    pollTimer = setInterval(poll, 1000);
    if (document.readyState !== 'loading') setTimeout(checkDark, 0);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (active && settings.mode === 'dynamic') scanTree(document);
    checkDark();
  });
  window.addEventListener('load', () => setTimeout(checkDark, 300));

  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.sync.get(DEFAULTS).then((s) => {
      settings = { ...DEFAULTS, ...s };
      apply();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? DEFAULTS[k];
      apply();
    });
    if (IS_TOP) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg && msg.type === 'status') sendResponse({ ...status, host: HOST });
      });
    }
  } else {
    // running outside the extension (test page): use defaults
    window.__dusk = { apply: (s) => { settings = { ...DEFAULTS, ...s }; apply(); }, teardown, status: () => status };
    apply();
  }
})();
