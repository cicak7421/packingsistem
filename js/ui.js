// Flowmua UI layer: bikin perpindahan terasa instan & mulus.
//  - Pindah tab di dashboard = soft navigation (tanpa reload halaman) + animasi keluar/masuk konten
//  - Pindah antar halaman: progress bar, fade-out cepat, prefetch saat hover
//  - Progress bar tipis otomatis tiap ada request API yang agak lama
//  - Angka statistik berhitung naik, toast pengganti alert(), ripple tombol, spinner tombol,
//    command palette (Ctrl/Cmd + K) buat loncat ke menu mana pun
(function () {
  'use strict';
  if (window.__flowmuaUI) return;
  window.__flowmuaUI = true;

  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasXDocVT = 'CSSViewTransitionRule' in window; // transisi lintas-halaman native (Chrome/Edge/Safari baru)
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ============================ Progress bar ============================
  let bar, barTimer, barVal = 0, barBusy = 0, barShowTimer;
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'topProgress';
    bar.innerHTML = '<i></i>';
    document.body.appendChild(bar);
    return bar;
  }
  function progressStart() {
    ensureBar();
    clearInterval(barTimer);
    bar.classList.remove('done');
    bar.classList.add('on');
    barVal = 0.08;
    bar.firstChild.style.transform = `scaleX(${barVal})`;
    barTimer = setInterval(() => {
      barVal += (0.92 - barVal) * 0.08; // melambat mendekati 92%, selesai cuma saat benar-benar kelar
      bar.firstChild.style.transform = `scaleX(${barVal})`;
    }, 140);
  }
  function progressDone() {
    if (!bar) return;
    clearInterval(barTimer);
    bar.firstChild.style.transform = 'scaleX(1)';
    bar.classList.add('done');
    setTimeout(() => { if (bar.classList.contains('done')) { bar.classList.remove('on', 'done'); bar.firstChild.style.transform = 'scaleX(0)'; } }, 340);
  }
  window.flowmuaProgress = { start: progressStart, done: progressDone };

  // Request /api yang lebih lama dari 250 ms memunculkan progress bar; yang cepat tidak berkedip.
  if (window.fetch) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') !== 0 && url.indexOf('/api/') === -1) return nativeFetch(input, init);
      barBusy++;
      if (barBusy === 1) barShowTimer = setTimeout(progressStart, 250);
      const end = () => {
        barBusy = Math.max(0, barBusy - 1);
        if (barBusy === 0) { clearTimeout(barShowTimer); progressDone(); }
      };
      return nativeFetch(input, init).then((r) => { end(); return r; }, (e) => { end(); throw e; });
    };
  }

  // ============================ Toast (pengganti alert) ============================
  let toastBox;
  const ICONS = {
    ok: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    err: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5v.01"/>',
  };
  function toast(message, type, ms) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.id = 'toastBox';
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    const text = String(message == null ? '' : message);
    if (!type) type = /gagal|error|salah|tidak (bisa|boleh|ditemukan)|terlalu|habis|bermasalah|wajib|minimal|lengkapi/i.test(text) ? 'err' : /berhasil|tersimpan|disimpan|disalin|dihapus|selesai|ditambah|diperbarui/i.test(text) ? 'ok' : 'info';
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    el.innerHTML = `<span class="toast-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[type]}</svg></span><span class="toast-msg">${esc(text)}</span><button type="button" class="toast-x" aria-label="Tutup">&times;</button><i class="toast-life"></i>`;
    const life = ms || Math.min(7000, 2800 + text.length * 40);
    el.style.setProperty('--life', life + 'ms');
    const close = () => {
      if (el.__closing) return;
      el.__closing = true;
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    };
    el.querySelector('.toast-x').onclick = close;
    el.onclick = (e) => { if (e.target === el) close(); };
    toastBox.appendChild(el);
    while (toastBox.children.length > 4) toastBox.firstChild.remove();
    setTimeout(close, life);
    return el;
  }
  window.toast = toast;
  window.__nativeAlert = window.alert.bind(window);
  window.alert = function (m) { toast(m); };

  // ============================ Navigasi ============================
  const isTabPage = () => typeof window.showPanel === 'function' && typeof window.getTabFromUrl === 'function';
  const samePage = (u) => u.pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, '');
  let softBusy = false;

  function softSwitchTab(href, push) {
    const u = new URL(href, location.href);
    const tab = u.searchParams.get('tab') || 'dashboard';
    if (push && u.search === location.search && u.pathname === location.pathname) { closeSheet(); window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); return; }
    if (push) history.pushState({ tab }, '', u.pathname + u.search);
    closeSheet();
    const wrap = document.querySelector('.container-wide');
    const swap = () => {
      window.showPanel(tab);
      window.scrollTo(0, 0);
      if (wrap) { wrap.classList.remove('tab-leave'); wrap.classList.add('tab-enter'); setTimeout(() => wrap.classList.remove('tab-enter'), 480); }
      softBusy = false;
    };
    // Menu aktif langsung pindah (pill meluncur) selagi konten lama memudar keluar.
    if (typeof window.setShellActive === 'function') window.setShellActive(tab);
    if (!wrap || reduce) { swap(); return; }
    softBusy = true;
    wrap.classList.add('tab-leave');
    setTimeout(swap, 120);
  }
  function closeSheet() { if (typeof window.toggleNavSheet === 'function') window.toggleNavSheet(false); }

  function hardNavigate(href) {
    progressStart();
    if (!hasXDocVT && !reduce) document.body.classList.add('is-leaving');
    setTimeout(() => { location.href = href; }, hasXDocVT || reduce ? 0 : 130);
  }
  window.flowmuaGo = function (href) {
    const u = new URL(href, location.href);
    if (isTabPage() && samePage(u) && !softBusy) softSwitchTab(u.pathname + u.search, true);
    else hardNavigate(u.pathname + u.search);
  };

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    let u;
    try { u = new URL(a.href, location.href); } catch (err) { return; }
    if (u.origin !== location.origin || !/\.html$|^\/$/.test(u.pathname)) return;
    if (u.pathname === location.pathname && u.search === location.search && u.hash) return; // anchor biasa
    e.preventDefault();
    if (softBusy) return;
    if (isTabPage() && samePage(u) && a.closest('.sidebar, .bottomnav, .sheet-overlay, .late-alert-bar, #cmdk')) softSwitchTab(u.pathname + u.search, true);
    else hardNavigate(u.pathname + u.search);
  });

  window.addEventListener('popstate', () => { if (isTabPage()) softSwitchTab(location.pathname + location.search, false); });
  // Balik lewat tombol "Back" dari bfcache: bersihkan keadaan keluar & progress.
  window.addEventListener('pageshow', (e) => { document.body.classList.remove('is-leaving'); if (e.persisted) { barBusy = 0; progressDone(); } });

  // Prefetch halaman begitu kursor mendekat / jari menyentuh (untuk browser tanpa Speculation Rules).
  const prefetched = new Set();
  function prefetch(a) {
    try {
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || !/\.html$/.test(u.pathname) || samePage(u) || prefetched.has(u.pathname)) return;
      if (HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) return;
      prefetched.add(u.pathname);
      const l = document.createElement('link');
      l.rel = 'prefetch'; l.href = u.pathname;
      document.head.appendChild(l);
    } catch (err) { /* abaikan */ }
  }
  ['pointerenter', 'touchstart'].forEach((ev) => document.addEventListener(ev, (e) => {
    const a = e.target.closest && e.target.closest('.sidebar a, .bottomnav a');
    if (a) prefetch(a);
  }, { passive: true, capture: true }));

  // ============================ Angka berhitung naik ============================
  const numRe = /^\d{1,3}(?:\.\d{3})+$|^\d+$/;
  function countUp(el, from, to, dotted) {
    if (reduce || from === to) return;
    const dur = Math.min(900, 380 + Math.abs(to - from) * 2);
    const t0 = performance.now();
    el.__anim = true;
    const fmt = (n) => { const r = Math.round(n); return dotted ? r.toLocaleString('id-ID') : String(r); };
    (function step(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * eased);
      if (el.__obs) el.__obs.takeRecords(); // perubahan dari animasi sendiri jangan dianggap data baru
      if (p < 1) { el.__raf = requestAnimationFrame(step); } else { el.__anim = false; el.classList.remove('bump'); }
    })(t0);
    el.classList.add('bump');
  }
  function watchStat(el) {
    if (el.__watched) return;
    el.__watched = true;
    el.__last = numRe.test((el.textContent || '').trim()) ? parseInt(el.textContent.replace(/\./g, ''), 10) : 0;
    el.__obs = new MutationObserver(() => {
      const txt = (el.textContent || '').trim();
      if (!numRe.test(txt)) { el.__last = 0; return; }
      const to = parseInt(txt.replace(/\./g, ''), 10);
      cancelAnimationFrame(el.__raf);
      const from = el.__last;
      el.__last = to;
      countUp(el, from, to, txt.indexOf('.') > -1);
    });
    el.__obs.observe(el, { childList: true, characterData: true, subtree: true });
  }
  function scanStats(root) {
    (root || document).querySelectorAll('.stat-value').forEach(watchStat);
    const r = root || document;
    const list = r.querySelectorAll ? Array.from(r.querySelectorAll('.empty-state')) : [];
    if (r.matches && r.matches('.empty-state')) list.push(r);
    list.forEach((el) => el.classList.toggle('empty-loading', /^\s*Memuat/i.test(el.textContent || '')));
  }

  // ============================ Tombol: ripple & spinner ============================
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('button.btn, button.btn-outline, .perf-chip, .courier-chip, .inv-qty-btn');
    if (!b || b.disabled || reduce) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 1.6;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 620);
  }, { passive: true });

  // Tombol yang lagi "Memproses..." otomatis dapat spinner.
  new MutationObserver((list) => {
    for (const m of list) {
      const b = m.target;
      if (!(b instanceof HTMLButtonElement) || !b.classList.contains('btn')) continue;
      b.classList.toggle('is-busy', b.disabled && /(\.\.\.|…)\s*$/.test(b.textContent));
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['disabled'] });

  // ============================ Command palette ============================
  let cmdk, cmdIdx = 0, cmdItems = [];
  function paletteItems() {
    const user = typeof getUser === 'function' ? getUser() : null;
    if (!user || typeof NAV_ITEMS === 'undefined') return [];
    const list = NAV_ITEMS.filter((i) => i.roles.includes(user.role)).map((i) => ({ label: i.label, href: i.href, icon: i.icon, kind: 'Menu' }));
    list.push({ label: 'Ganti tema terang / gelap', run: () => window.toggleTheme(), icon: 'settings', kind: 'Aksi' });
    list.push({ label: 'Ganti password', run: () => window.openChangePasswordModal(), icon: 'settings', kind: 'Aksi' });
    list.push({ label: 'Keluar', run: () => window.confirmLogout(), icon: 'logout', kind: 'Aksi' });
    return list;
  }
  function renderPalette(q) {
    const all = paletteItems();
    const needle = (q || '').trim().toLowerCase();
    cmdItems = needle ? all.filter((i) => i.label.toLowerCase().includes(needle)) : all;
    cmdIdx = 0;
    const box = $('.cmdk-list', cmdk);
    box.innerHTML = cmdItems.length
      ? cmdItems.map((i, n) => `<button type="button" class="cmdk-item${n === 0 ? ' sel' : ''}" data-i="${n}">${window.navIcon ? window.navIcon(i.icon) : ''}<span>${esc(i.label)}</span><em>${i.kind}</em></button>`).join('')
      : '<div class="cmdk-empty">Gak ada menu yang cocok</div>';
  }
  function pickPalette(n) {
    const it = cmdItems[n];
    if (!it) return;
    closePalette();
    if (it.run) setTimeout(it.run, 120); else window.flowmuaGo(it.href);
  }
  function openPalette() {
    if (typeof getUser !== 'function' || !getUser()) return;
    if (!cmdk) {
      cmdk = document.createElement('div');
      cmdk.id = 'cmdk';
      cmdk.innerHTML = '<div class="cmdk-box" role="dialog" aria-modal="true" aria-label="Cari menu"><div class="cmdk-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" placeholder="Mau ke mana? Ketik nama menu..." autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div><div class="cmdk-list"></div><div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> pilih</span><span><kbd>Enter</kbd> buka</span></div></div>';
      document.body.appendChild(cmdk);
      cmdk.addEventListener('mousedown', (e) => { if (e.target === cmdk) closePalette(); });
      const input = $('input', cmdk);
      input.addEventListener('input', () => renderPalette(input.value));
      input.addEventListener('keydown', (e) => {
        const items = cmdk.querySelectorAll('.cmdk-item');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!items.length) return;
          items[cmdIdx].classList.remove('sel');
          cmdIdx = (cmdIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[cmdIdx].classList.add('sel');
          items[cmdIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') { e.preventDefault(); pickPalette(cmdIdx); }
        else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      });
      cmdk.addEventListener('click', (e) => { const b = e.target.closest('.cmdk-item'); if (b) pickPalette(+b.dataset.i); });
      cmdk.addEventListener('mousemove', (e) => {
        const b = e.target.closest('.cmdk-item');
        if (!b || +b.dataset.i === cmdIdx) return;
        const cur = cmdk.querySelector('.cmdk-item.sel'); if (cur) cur.classList.remove('sel');
        cmdIdx = +b.dataset.i; b.classList.add('sel');
      });
    }
    $('input', cmdk).value = '';
    renderPalette('');
    cmdk.classList.remove('out');
    cmdk.classList.add('open');
    setTimeout(() => $('input', cmdk).focus(), 20);
  }
  function closePalette() {
    if (!cmdk || !cmdk.classList.contains('open')) return;
    cmdk.classList.add('out');
    setTimeout(() => cmdk.classList.remove('open', 'out'), 160);
  }
  window.openCommandPalette = openPalette;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); cmdk && cmdk.classList.contains('open') ? closePalette() : openPalette(); }
  });

  // ============================ Mulai ============================
  function init() {
    scanStats();
    // Kartu statistik yang muncul belakangan (mis. hasil render ulang) ikut dipantau.
    new MutationObserver((list) => {
      for (const m of list) {
        const t = m.target;
        if (t && t.nodeType === 1 && t.classList && t.classList.contains('empty-state')) scanStats(t);
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1 || n.tagName === 'TR' || n.tagName === 'TD') return;
          if (n.matches && n.matches('.stat-value')) watchStat(n); else scanStats(n);
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
    requestAnimationFrame(() => document.documentElement.classList.add('ui-ready'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
