// Tiny syntax highlighter for Candor code blocks: <pre><code class="cnd">.
(() => {
  const KW = new Set(['fn', 'end', 'let', 'var', 'if', 'then', 'else', 'while', 'do', 'for', 'in', 'return',
    'break', 'continue', 'match', 'case', 'type', 'record', 'enum', 'requires', 'ensures', 'example',
    'effects', 'and', 'or', 'not', 'true', 'false', 'inout']);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const re = /(#[^\n]*)|("(?:\\.|[^"\\])*")|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b[A-Za-z_]\w*\b)/g;
  const paint = (src) => {
    let out = '', last = 0;
    src.replace(re, (m, com, str, num, word, i) => {
      out += esc(src.slice(last, i));
      last = i + m.length;
      if (com) out += `<span class="tok-com">${esc(m)}</span>`;
      else if (str) out += `<span class="tok-str">${esc(m)}</span>`;
      else if (num) out += `<span class="tok-num">${esc(m)}</span>`;
      else if (KW.has(word)) out += `<span class="tok-kw">${m}</span>`;
      else if (/^[A-Z]/.test(word)) out += `<span class="tok-ty">${m}</span>`;
      else out += esc(m);
      return m;
    });
    return out + esc(src.slice(last));
  };
  for (const el of document.querySelectorAll('code.cnd')) el.innerHTML = paint(el.textContent);
})();
