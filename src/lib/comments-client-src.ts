// Vanilla-JS client for highlight-to-comment. Served as a script (login-gated in the Files viewer)
// and reused by the shared view so behaviour cannot drift. It builds its UI with createElement and
// textContent only (comment text, names and quotes are never inserted as HTML) and paints highlights
// with the CSS Custom Highlight API, which does not modify the DOM, so page content is never touched.
// No backticks, template expressions or eval inside the string below.

export const CLIENT_JS: string = String.raw`
(function () {
  if (window.GLComments) return;

  var CENTRAL = 'America/Chicago';

  function strip(s) { return String(s || '').replace(/\s+/g, ''); }

  function parseTime(t) {
    if (!t) return null;
    var s = String(t);
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(s)) s = s.replace(' ', 'T') + 'Z';
    else if (/^\d{4}-\d\d-\d\dT[\d:.]+$/.test(s)) s = s + 'Z';
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtTime(t) {
    var d = parseTime(t);
    if (!d) return '';
    try {
      return d.toLocaleString('en-US', { timeZone: CENTRAL, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
    } catch (e) { return d.toISOString(); }
  }

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (k === 'text') n.textContent = props[k];
        else if (k === 'style') n.style.cssText = props[k];
        else if (k === 'testid') n.setAttribute('data-testid', props[k]);
        else if (k === 'class') n.className = props[k];
        else n.setAttribute(k, props[k]);
      }
    }
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
    return n;
  }

  // Index of the text under root with all whitespace removed, mapping each kept char to its text node.
  function buildIndex(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var text = '';
    var map = [];
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) {
      nodes.push(n);
      var v = n.nodeValue || '';
      for (var i = 0; i < v.length; i++) {
        if (/\s/.test(v.charAt(i))) continue;
        text += v.charAt(i);
        map.push({ node: n, off: i });
      }
    }
    return { text: text, map: map, nodes: nodes };
  }

  function posOf(idx, node, off) {
    var count = 0;
    var tmp = document.createRange();
    var pt = document.createRange();
    try { pt.setStart(node, off); pt.collapse(true); } catch (e) { return 0; }
    for (var i = 0; i < idx.nodes.length; i++) {
      var t = idx.nodes[i];
      var v = t.nodeValue || '';
      if (t === node) return count + strip(v.substring(0, off)).length;
      tmp.setStart(t, 0);
      tmp.collapse(true);
      if (pt.compareBoundaryPoints(Range.START_TO_START, tmp) <= 0) return count;
      count += strip(v).length;
    }
    return count;
  }

  function commonSuffixLen(a, b) {
    var i = 0;
    while (i < a.length && i < b.length && a.charAt(a.length - 1 - i) === b.charAt(b.length - 1 - i)) i++;
    return i;
  }
  function commonPrefixLen(a, b) {
    var i = 0;
    while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++;
    return i;
  }

  // Returns {s, e, exact} in stripped-text offsets, or null when the original text is gone.
  function locate(a, idx) {
    var q = strip(a.quote);
    var pre = strip(a.prefix);
    var suf = strip(a.suffix);
    var text = idx.text;
    if (!q) return null;
    var best = null;
    var from = 0;
    var p;
    while ((p = text.indexOf(q, from)) !== -1) {
      var score = commonSuffixLen(pre, text.substring(Math.max(0, p - pre.length), p)) +
        commonPrefixLen(suf, text.substring(p + q.length, p + q.length + suf.length));
      var dist = typeof a.start === 'number' ? Math.abs(a.start - p) : 0;
      if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { s: p, e: p + q.length, score: score, dist: dist };
      from = p + 1;
    }
    if (best) return { s: best.s, e: best.e, exact: true };
    if (!pre || !suf) return null;
    var pi = text.indexOf(pre);
    if (pi === -1) return null;
    var st = pi + pre.length;
    var si = text.indexOf(suf, st);
    if (si === -1 || si - st > q.length * 2 + 80) return null;
    if (si <= st) return null;
    return { s: st, e: si, exact: false };
  }

  function makeRange(idx, s, e) {
    if (e <= s || !idx.map[s] || !idx.map[e - 1]) return null;
    var a = idx.map[s];
    var b = idx.map[e - 1];
    var r = document.createRange();
    try {
      r.setStart(a.node, a.off);
      r.setEnd(b.node, b.off + 1);
    } catch (err) { return null; }
    return r;
  }

  function normalize(data) {
    var list = Array.isArray(data) ? data : (data && (data.comments || data.threads)) || [];
    var byId = {};
    var roots = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      c.replies = Array.isArray(c.replies) ? c.replies.slice() : [];
      byId[c.id] = c;
    }
    for (i = 0; i < list.length; i++) {
      var x = list[i];
      var pid = x.parent_id != null ? x.parent_id : x.parent;
      if (pid != null && byId[pid]) byId[pid].replies.push(x);
      else roots.push(x);
    }
    return roots.map(function (c) {
      var a = c.anchor && typeof c.anchor === 'object' ? c.anchor : c;
      if (typeof c.anchor === 'string') { try { a = JSON.parse(c.anchor); } catch (e) { a = c; } }
      return {
        raw: c,
        id: c.id,
        quote: a.quote || '',
        prefix: a.prefix || '',
        suffix: a.suffix || '',
        start: typeof a.start === 'number' ? a.start : a.start_offset,
        resolved: !!(c.resolved || c.status === 'resolved' || c.resolved_at),
        replies: c.replies
      };
    });
  }

  function mount(opts) {
    var root = opts.root;
    var api = opts.api;
    var mode = opts.mode === 'share' ? 'share' : 'owner';
    var pillHost = opts.pillHost || null;
    var destroyed = false;
    var threads = [];
    var located = {};
    var hasHL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
    var open = false;
    var composerOpen = false;
    var pendingSel = null;
    var pollTimer = null;
    var debTimer = null;
    var errMsg = '';
    var nodes = [];

    var style = el('style', { text: '::highlight(gl-comment){background:rgba(255,205,60,.35);} ::highlight(gl-comment-active){background:rgba(255,150,0,.65);}' });
    document.head.appendChild(style);
    nodes.push(style);

    var pill = el('button', { type: 'button', testid: 'gl-comment-pill', text: 'Comments (0)', style: pillHost ? 'background:none;color:#c9a24a;border:0;border-radius:8px;padding:0.25rem 0.5rem;font:inherit;font-weight:600;cursor:pointer;display:none;white-space:nowrap;' : 'position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#c9a24a;color:#000;border:0;border-radius:999px;padding:8px 14px;font:600 12px sans-serif;cursor:pointer;display:none;' });
    if (pillHost) pill.className = 'hover-pill';
    var drawer = el('div', { testid: 'gl-comment-drawer', style: 'position:fixed;top:0;right:0;bottom:0;width:340px;max-width:92vw;z-index:2147483001;background:#12171d;color:#e6e6e6;border-left:1px solid #2a323b;font:13px sans-serif;display:none;flex-direction:column;' });
    var head = el('div', { style: 'padding:10px 12px;border-bottom:1px solid #2a323b;display:flex;justify-content:space-between;align-items:center;font-weight:600;', }, [
      el('span', { text: 'Comments' }),
      el('button', { type: 'button', text: 'Close', style: 'background:none;border:0;color:#9aa;cursor:pointer;', 'data-gl': 'close' })
    ]);
    var errBox = el('div', { testid: 'gl-comment-error', style: 'color:#ff8a80;padding:0 12px;font-size:12px;' });
    var listBox = el('div', { style: 'overflow:auto;padding:8px 12px;flex:1;' });
    drawer.appendChild(head);
    drawer.appendChild(errBox);
    drawer.appendChild(listBox);
    (pillHost || document.body).appendChild(pill);
    document.body.appendChild(drawer);
    nodes.push(pill, drawer);

    var selBtn = el('button', { type: 'button', testid: 'gl-comment-btn', text: 'Comment', style: 'position:fixed;z-index:2147483002;background:#c9a24a;color:#000;border:0;border-radius:6px;padding:5px 10px;font:600 12px sans-serif;cursor:pointer;display:none;' });
    document.body.appendChild(selBtn);
    nodes.push(selBtn);

    var composer = el('div', { testid: 'gl-composer', style: 'position:fixed;z-index:2147483003;background:#12171d;color:#e6e6e6;border:1px solid #2a323b;border-radius:8px;padding:8px;width:280px;display:none;font:13px sans-serif;' });
    document.body.appendChild(composer);
    nodes.push(composer);

    pill.addEventListener('click', function () { open = !open; renderDrawer(); });
    head.querySelector('[data-gl=close]').addEventListener('click', function () { open = false; renderDrawer(); });

    function renderDrawer() { drawer.style.display = open ? 'flex' : 'none'; }

    function setError(msg) { errMsg = msg || ''; errBox.textContent = errMsg; }

    function request(method, body) {
      var o = { method: method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
      if (body) o.body = JSON.stringify(body);
      return fetch(api, o).then(function (res) {
        if (!res.ok) {
          var err = new Error(res.status === 429 ? 'Too many requests. Please wait a moment and try again.' : res.status === 404 ? 'Comments are not available for this page.' : 'Something went wrong (' + res.status + ').');
          err.status = res.status;
          throw err;
        }
        return res.json().catch(function () { return {}; });
      });
    }

    var firstLoad = true;
    function load() {
      if (destroyed) return Promise.resolve();
      return request('GET').then(function (data) {
        if (destroyed) return;
        threads = normalize(data);
        firstLoad = false;
        pill.style.display = pillHost ? 'inline-block' : 'block';
        setError('');
        refresh();
      }).catch(function (err) {
        if (destroyed) return;
        if (firstLoad) { destroy(); return; } // fail quietly when the comments API is unavailable
        setError(err.message);
      });
    }

    function positionOf(t) {
      var l = located[t.id];
      return l && l.s != null ? l.s : 1e9;
    }

    function refresh() {
      var idx = buildIndex(root);
      located = {};
      var ranges = [];
      var activeId = refresh.activeId;
      var i;
      for (i = 0; i < threads.length; i++) {
        var t = threads[i];
        var loc = locate(t, idx);
        var r = loc ? makeRange(idx, loc.s, loc.e) : null;
        located[t.id] = r ? { s: loc.s, range: r, exact: loc.exact } : { s: null, range: null };
        if (r && !t.resolved) ranges.push(r);
      }
      if (hasHL) {
        if (ranges.length) {
          var hl = new Highlight();
          for (var k = 0; k < ranges.length; k++) hl.add(ranges[k]);
          CSS.highlights.set('gl-comment', hl);
        } else CSS.highlights.delete('gl-comment');
        var ar = activeId != null && located[activeId] && located[activeId].range;
        if (ar) CSS.highlights.set('gl-comment-active', new Highlight(ar));
        else CSS.highlights.delete('gl-comment-active');
      }
      renderList();
    }

    function renderComment(c, isReply) {
      var guest = c.source === 'share';
      var who = c.author || c.author_name || c.name || (guest ? 'Guest' : 'Owner');
      var meta = el('div', { style: 'font-size:11px;color:#9aa;margin-bottom:2px;' }, [
        el('strong', { testid: 'gl-author', text: who, style: 'color:#e6e6e6;' }),
        guest ? el('span', { text: ' Guest', style: 'margin-left:4px;background:#2a323b;border-radius:4px;padding:0 4px;' }) : null,
        el('span', { testid: 'gl-time', text: ' ' + fmtTime(c.created_at || c.createdAt), style: 'margin-left:6px;' })
      ]);
      return el('div', { style: isReply ? 'margin:6px 0 0 10px;padding-left:8px;border-left:2px solid #2a323b;' : '' }, [
        meta,
        el('div', { testid: 'gl-body', text: c.body || c.text || '', style: 'white-space:pre-wrap;word-break:break-word;' })
      ]);
    }

    function renderThread(t) {
      var loc = located[t.id];
      var changed = !loc || !loc.range;
      var box = el('div', { testid: 'gl-thread', style: 'border:1px solid #2a323b;border-radius:8px;padding:8px;margin-bottom:8px;' });
      var quote = el('div', { testid: 'gl-quote', text: t.quote, style: 'border-left:3px solid #c9a24a;padding-left:6px;color:#bbb;font-style:italic;margin-bottom:6px;cursor:pointer;max-height:64px;overflow:hidden;' });
      quote.addEventListener('click', function () { focusThread(t); });
      box.appendChild(quote);
      if (changed) box.appendChild(el('div', { text: 'Original text changed', style: 'font-size:11px;color:#e0a040;margin-bottom:4px;' }));
      box.appendChild(renderComment(t.raw, false));
      for (var i = 0; i < t.replies.length; i++) box.appendChild(renderComment(t.replies[i], true));
      var reply = el('textarea', { testid: 'gl-reply-text', rows: '2', placeholder: 'Reply', style: 'width:100%;margin-top:6px;background:#0b0f14;color:#e6e6e6;border:1px solid #2a323b;border-radius:6px;padding:4px;box-sizing:border-box;' });
      var replyBtn = el('button', { type: 'button', testid: 'gl-reply-btn', text: 'Reply', style: 'margin-top:4px;background:#2a323b;color:#e6e6e6;border:0;border-radius:6px;padding:3px 8px;cursor:pointer;' });
      replyBtn.addEventListener('click', function () {
        var v = reply.value.trim();
        if (!v) return;
        var payload = { body: v, parent_id: t.id };
        var nm = getName();
        if (mode === 'share') { if (!nm) { nm = askName(); if (!nm) return; } payload.author = nm; }
        request('POST', payload).then(function () { reply.value = ''; setError(''); return load(); }).catch(function (e) { setError(e.message); });
      });
      var resolveBtn = el('button', { type: 'button', testid: t.resolved ? 'gl-reopen-btn' : 'gl-resolve-btn', text: t.resolved ? 'Reopen' : 'Resolve', style: 'margin-top:4px;margin-left:6px;background:none;color:#c9a24a;border:1px solid #c9a24a;border-radius:6px;padding:2px 8px;cursor:pointer;' });
      resolveBtn.addEventListener('click', function () {
        var payload = { id: t.id, resolved: !t.resolved };
        if (mode === 'share') { var nm2 = getName(); if (nm2) payload.author = nm2; }
        request('PATCH', payload).then(function () { setError(''); return load(); }).catch(function (e) { setError(e.message); });
      });
      box.appendChild(reply);
      box.appendChild(el('div', null, [replyBtn, resolveBtn]));
      return box;
    }

    function renderList() {
      while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
      var openT = threads.filter(function (t) { return !t.resolved; });
      var doneT = threads.filter(function (t) { return t.resolved; });
      var sorter = function (a, b) { return positionOf(a) - positionOf(b); };
      openT.sort(sorter);
      doneT.sort(sorter);
      pill.textContent = 'Comments (' + openT.length + ')';
      if (!threads.length) listBox.appendChild(el('div', { text: 'Select text on the page and click Comment.', style: 'color:#9aa;' }));
      for (var i = 0; i < openT.length; i++) listBox.appendChild(renderThread(openT[i]));
      if (doneT.length) {
        var det = el('details', { testid: 'gl-resolved-section' }, [el('summary', { text: 'Resolved (' + doneT.length + ')', style: 'cursor:pointer;color:#9aa;margin:6px 0;' })]);
        for (var j = 0; j < doneT.length; j++) det.appendChild(renderThread(doneT[j]));
        listBox.appendChild(det);
      }
    }

    function focusThread(t) {
      var loc = located[t.id];
      if (!loc || !loc.range) return;
      var rect = loc.range.getBoundingClientRect();
      window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - window.innerHeight / 3), behavior: 'smooth' });
      refresh.activeId = t.id;
      refresh();
      setTimeout(function () { if (refresh.activeId === t.id) { refresh.activeId = null; if (!destroyed) refresh(); } }, 1500);
    }

    function getName() { try { return localStorage.getItem('gl_comment_name') || ''; } catch (e) { return ''; } }
    function askName() {
      var v = (window.prompt('Your name (shown next to your comments):') || '').trim().slice(0, 60);
      if (v) { try { localStorage.setItem('gl_comment_name', v); } catch (e) {} }
      return v;
    }

    // Selection handling
    function currentSelection() {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      var r = sel.getRangeAt(0);
      if (!root.contains(r.commonAncestorContainer)) return null;
      var quote = sel.toString().trim();
      if (!quote) return null;
      return { range: r.cloneRange(), quote: quote };
    }

    function updateSelBtn() {
      if (destroyed || composerOpen) return;
      var s = currentSelection();
      if (!s) { selBtn.style.display = 'none'; return; }
      var rect = s.range.getBoundingClientRect();
      selBtn.style.left = Math.max(8, Math.min(window.innerWidth - 90, rect.right)) + 'px';
      selBtn.style.top = Math.max(8, Math.min(window.innerHeight - 40, rect.bottom + 6)) + 'px';
      selBtn.style.display = 'block';
    }

    function onMouseUp() { setTimeout(updateSelBtn, 0); }
    function onSelChange() { updateSelBtn(); }
    root.addEventListener('mouseup', onMouseUp);
    root.addEventListener('keyup', onMouseUp);
    document.addEventListener('selectionchange', onSelChange);

    selBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    selBtn.addEventListener('click', function () {
      var s = currentSelection();
      if (!s) return;
      var idx = buildIndex(root);
      var a = posOf(idx, s.range.startContainer, s.range.startOffset);
      var b = posOf(idx, s.range.endContainer, s.range.endOffset);
      var quote = s.quote.slice(0, 1000);
      var qs = strip(quote);
      if (b - a > qs.length) b = a + qs.length;
      pendingSel = {
        quote: quote,
        prefix: idx.text.substring(Math.max(0, a - 40), a),
        suffix: idx.text.substring(b, b + 40),
        start: a,
        end: a + qs.length
      };
      openComposer(parseInt(selBtn.style.left, 10), parseInt(selBtn.style.top, 10));
    });

    function closeComposer() {
      composerOpen = false;
      composer.style.display = 'none';
      while (composer.firstChild) composer.removeChild(composer.firstChild);
      pendingSel = null;
    }

    function openComposer(x, y) {
      composerOpen = true;
      selBtn.style.display = 'none';
      while (composer.firstChild) composer.removeChild(composer.firstChild);
      composer.style.left = Math.max(8, Math.min(window.innerWidth - 300, x)) + 'px';
      composer.style.top = Math.max(8, Math.min(window.innerHeight - 200, y)) + 'px';
      composer.style.display = 'block';
      var nameInput = null;
      if (mode === 'share' && !getName()) {
        nameInput = el('input', { type: 'text', testid: 'gl-name-input', placeholder: 'Your name', maxlength: '60', style: 'width:100%;margin-bottom:6px;background:#0b0f14;color:#e6e6e6;border:1px solid #2a323b;border-radius:6px;padding:4px;box-sizing:border-box;' });
        composer.appendChild(nameInput);
      }
      var ta = el('textarea', { testid: 'gl-comment-text', rows: '3', placeholder: 'Add a comment', style: 'width:100%;background:#0b0f14;color:#e6e6e6;border:1px solid #2a323b;border-radius:6px;padding:4px;box-sizing:border-box;' });
      var save = el('button', { type: 'button', testid: 'gl-comment-save', text: 'Save', style: 'background:#c9a24a;color:#000;border:0;border-radius:6px;padding:4px 10px;font-weight:600;cursor:pointer;margin-right:6px;' });
      var cancel = el('button', { type: 'button', testid: 'gl-comment-cancel', text: 'Cancel', style: 'background:none;color:#9aa;border:0;cursor:pointer;' });
      var cerr = el('div', { style: 'color:#ff8a80;font-size:12px;margin-top:4px;' });
      composer.appendChild(ta);
      composer.appendChild(el('div', { style: 'margin-top:6px;' }, [save, cancel]));
      composer.appendChild(cerr);
      ta.focus();
      cancel.addEventListener('click', closeComposer);
      save.addEventListener('click', function () {
        var v = ta.value.trim();
        if (!v || !pendingSel) return;
        var payload = { body: v, anchor: pendingSel };
        if (mode === 'share') {
          var nm = getName();
          if (!nm && nameInput) {
            nm = nameInput.value.trim().slice(0, 60);
            if (nm) { try { localStorage.setItem('gl_comment_name', nm); } catch (e) {} }
          }
          if (!nm) { cerr.textContent = 'Please enter your name.'; return; }
          payload.author = nm;
        }
        save.disabled = true;
        request('POST', payload).then(function () {
          closeComposer();
          try { window.getSelection().removeAllRanges(); } catch (e) {}
          open = true;
          renderDrawer();
          return load();
        }).catch(function (e) { save.disabled = false; cerr.textContent = e.message; });
      });
    }

    var mo = null;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(function () {
        clearTimeout(debTimer);
        debTimer = setTimeout(function () { if (!destroyed && !firstLoad) refresh(); }, 300);
      });
      mo.observe(root, { childList: true, subtree: true, characterData: true });
    }

    pollTimer = setInterval(load, 20000);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(pollTimer);
      clearTimeout(debTimer);
      if (mo) mo.disconnect();
      root.removeEventListener('mouseup', onMouseUp);
      root.removeEventListener('keyup', onMouseUp);
      document.removeEventListener('selectionchange', onSelChange);
      if (hasHL) { CSS.highlights.delete('gl-comment'); CSS.highlights.delete('gl-comment-active'); }
      for (var i = 0; i < nodes.length; i++) if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }

    load();
    return { destroy: destroy, refresh: load };
  }

  window.GLComments = { mount: mount };
})();
`;
