// Tab "Retur" di dashboard (admin & CS). Backend: api/_lib/routes/retur.js.
// Dimuat setelah dashboard.js, jadi boleh pakai helper-nya (api, estEsc, estNum, estRupiah, formatSkuChips, toast).
(function () {
  'use strict';

  const state = { page: 1, totalPages: 1, from: '', to: '', q: '', seq: 0, inited: false };
  let searchTimer = null;
  let alasanList = [];
  let masalahList = [];
  const rowsById = new Map(); // baris yang lagi tampil -> bahan form validasi
  let valRow = null; // retur yang lagi dibuka di form validasi
  const $ = (id) => document.getElementById(id);
  const say = (msg, type) => { if (typeof toast === 'function') toast(msg, type || 'info'); };

  function wibToday() {
    return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  }

  function fillAlasan(list) {
    const sel = $('returAlasan');
    if (list && list.length) alasanList = list;
    if (!sel || !list || !list.length || sel.options.length === list.length) return;
    sel.innerHTML = list.map((a) => `<option>${estEsc(a)}</option>`).join('');
  }

  window.initRetur = function () {
    if (!state.inited) {
      state.inited = true;
      state.to = wibToday();
      state.from = addDays(state.to, -29);
    }
    renderRangeText();
    loadRetur();
  };

  // Dipakai kartu "Pesanan Retur" di tab Estimasi buat lompat ke tab ini.
  window.showPanelLink = function (name) {
    if (typeof window.flowmuaGo === 'function') window.flowmuaGo('/dashboard.html?tab=' + name);
    else window.location.href = '/dashboard.html?tab=' + name;
  };

  async function loadRetur() {
    const seq = ++state.seq;
    const tbody = $('returTable');
    const params = new URLSearchParams({ from: state.from, to: state.to, page: state.page, limit: 50 });
    if (state.q) params.set('q', state.q);
    try {
      const data = await api('/retur?' + params.toString());
      if (seq !== state.seq) return;
      fillAlasan(data.alasan);
      if (data.masalah && data.masalah.length) masalahList = data.masalah;
      rowsById.clear();
      (data.returs || []).forEach((r) => rowsById.set(String(r.id), r));
      $('returNotice').innerHTML = data.ready === false
        ? `<div class="card" style="border-color:var(--warn);"><b>Fitur retur belum aktif.</b> <span class="hint">${estEsc(data.message || '')}</span></div>`
        : '';
      const s = data.summary || {};
      $('returTotal').textContent = estNum(s.total);
      $('returNilai').textContent = estRupiah(s.nilai);
      $('returMenunggu').textContent = estNum(s.menunggu);
      $('returSesuai').textContent = estNum(s.sesuai);
      $('returTidakSesuai').textContent = estNum(s.tidak_sesuai);

      state.totalPages = data.total_pages || 1;
      if (!data.returs.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Belum ada retur di rentang tanggal ini.</td></tr>';
      } else {
        tbody.innerHTML = data.returs.map((r) => {
          const tidak = r.retur_kondisi === 'tidak_sesuai';
          // Validasi lewat form detail (pcs balik / rusak per SKU + kenapa tidak sesuai). Sudah divalidasi: bisa dikoreksi.
          const validasi = r.validated
            ? `<span class="badge ${tidak ? 'badge-danger' : 'badge-ok'}">${tidak ? 'Tidak sesuai' : 'Sesuai'}</span>${tidak && r.retur_masalah ? `<div style="font-weight:600; margin-top:4px;">${estEsc(r.retur_masalah)}</div>` : ''}<div class="hint">${estEsc(r.retur_validated_by_name || '')}</div>`
            : '<span class="badge badge-warn">Menunggu</span>';
          const aksi = `<button type="button" class="btn-outline${r.validated ? '' : ' btn-ya'}" data-id="${r.id}" onclick="openReturValidasi(this)">${r.validated ? 'Koreksi' : 'Validasi'}</button>`;
          return `<tr${r.validated ? '' : ' class="row-menunggu"'}>
            <td style="white-space:nowrap;">${estEsc(fmtTime(r.retur_at))}</td>
            <td>${estEsc(r.no_pesanan)}<div class="hint">${estEsc(r.no_resi || '-')}</div></td>
            <td>${estEsc(r.toko || '-')}</td>
            <td>${typeof formatSkuChips === 'function' ? formatSkuChips(r.sku) : estEsc(r.sku)}</td>
            <td>${validasi}</td>
            <td>${detailCell(r)}</td>
            <td>${alasanSelect(r)}${r.retur_catatan ? `<div class="hint">${estEsc(r.retur_catatan)}</div>` : ''}</td>
            <td>${estEsc(r.retur_by_name || '-')}</td>
            <td style="text-align:right;"><b>${estRupiah(r.nilai)}</b></td>
            <td><div class="retur-actions">${aksi}<button type="button" class="btn-outline" data-id="${r.id}" data-no="${estEsc(r.no_pesanan)}" onclick="cancelRetur(this)">Batalkan</button></div></td>
          </tr>`;
        }).join('');
      }
      const from = data.total ? (data.page - 1) * data.limit + 1 : 0;
      const to = Math.min(data.total, data.page * data.limit);
      $('returPageInfo').textContent = data.total ? `${estNum(from)}–${estNum(to)} dari ${estNum(data.total)} retur` : '';
      $('returPrevBtn').disabled = state.page <= 1;
      $('returNextBtn').disabled = state.page >= state.totalPages;
    } catch (e) {
      if (seq !== state.seq) return;
      tbody.innerHTML = `<tr><td colspan="10" class="empty-state">${estEsc(e.message)}</td></tr>`;
    }
  }

  // Rincian hasil validasi per SKU: berapa yang balik dari yang dipesan, berapa rusak, berapa masuk stok.
  function detailCell(r) {
    if (!r.validated) return '<span class="hint">belum dicek</span>';
    if (!r.retur_items || !r.retur_items.length) return '<span class="hint">tanpa rincian (validasi lama)</span>';
    let masuk = 0;
    const lines = r.retur_items.map((it) => {
      const balik = Number(it.qty_balik) || 0, pesan = Number(it.qty_pesan) || 0, rusak = Number(it.qty_rusak) || 0;
      masuk += balik - rusak;
      const beda = balik !== pesan || rusak > 0;
      return `<div style="white-space:nowrap;${beda ? ' color:var(--danger);' : ''}"><b>${estEsc(it.sku)}</b> balik ${estNum(balik)}/${estNum(pesan)} pcs${rusak ? ` · rusak ${estNum(rusak)}` : ''}</div>`;
    }).join('');
    return `${lines}<div class="hint">masuk stok ${estNum(masuk)} pcs</div>`;
  }

  // Alasan bisa diisi / diubah langsung dari daftar (retur dari scan packing datang tanpa alasan).
  function alasanSelect(r) {
    const cur = r.retur_alasan || '';
    const opts = alasanList.includes(cur) || !cur ? alasanList : [cur, ...alasanList];
    return `<select data-id="${r.id}" data-prev="${estEsc(cur)}" onchange="saveReturAlasan(this)" style="width:auto; min-width:190px; margin:0; padding:6px 8px;${cur ? '' : ' border-color:var(--warn);'}">
      <option value=""${cur ? '' : ' selected'}>— belum diisi —</option>
      ${opts.map((a) => `<option${a === cur ? ' selected' : ''}>${estEsc(a)}</option>`).join('')}
    </select>`;
  }

  window.saveReturAlasan = async function (sel) {
    sel.disabled = true;
    try {
      await api('/retur/' + sel.dataset.id, { method: 'PATCH', body: JSON.stringify({ alasan: sel.value }) });
      sel.dataset.prev = sel.value;
      sel.style.borderColor = sel.value ? '' : 'var(--warn)';
      say('Alasan retur disimpan', 'ok');
    } catch (e) {
      sel.value = sel.dataset.prev;
      say(e.message || 'Gagal menyimpan alasan', 'err');
    } finally {
      sel.disabled = false;
    }
  };

  window.changeReturPage = function (delta) {
    const next = state.page + delta;
    if (next < 1 || next > state.totalPages) return;
    state.page = next;
    loadRetur();
  };

  window.onReturSearch = function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = $('returSearch').value.trim();
      state.page = 1;
      loadRetur();
    }, 350);
  };

  // Rentang tanggal dipilih lewat kalender popup bersama di dashboard.js (toggleCalPopup('retur')).
  function renderRangeText() {
    const fmt = typeof formatDateDisplay === 'function' ? formatDateDisplay : (d) => d;
    $('returRangeText').textContent = state.from && state.to ? `${fmt(state.from)} - ${fmt(state.to)}` : 'Pilih tanggal';
  }
  window.getReturRange = function () { return { from: state.from, to: state.to }; };
  window.setReturRange = function (from, to) {
    state.from = from; state.to = to; state.page = 1;
    renderRangeText();
    $('returExportMsg').textContent = '';
    loadRetur();
  };

  window.submitReturManual = async function () {
    const input = $('returValue');
    const value = input.value.trim();
    const msg = $('returMsg');
    if (!value) { msg.textContent = 'Isi No. Resi atau No. Pesanan dulu.'; input.focus(); return; }
    const btn = $('returSubmitBtn');
    btn.disabled = true;
    msg.textContent = 'Menyimpan...';
    try {
      const data = await api('/retur/scan', {
        method: 'POST',
        body: JSON.stringify({ value, alasan: $('returAlasan').value, catatan: $('returCatatan').value }),
      });
      msg.textContent = `${data.order.no_pesanan}: ${data.message}`;
      say('Retur dicatat: ' + data.order.no_pesanan, 'ok');
      input.value = '';
      $('returCatatan').value = '';
      input.focus();
      state.page = 1;
      loadRetur();
    } catch (e) {
      msg.textContent = e.message || 'Gagal mencatat retur';
      say(e.message || 'Gagal mencatat retur', 'err');
    } finally {
      btn.disabled = false;
    }
  };

  // ---------- Form validasi (atau koreksi) retur ----------
  // Per SKU diisi berapa pcs yang balik & berapa yang rusak. Masuk Inventory = balik - rusak.
  // Semua balik & tidak ada yang rusak = SESUAI; selain itu TIDAK SESUAI + wajib pilih kenapa.
  const valInputs = () => [...$('rvItems').querySelectorAll('tr[data-sku]')].map((tr) => ({
    tr, sku: tr.dataset.sku, pesan: Number(tr.dataset.pesan) || 0,
    balik: tr.querySelector('[data-f="balik"]'), rusak: tr.querySelector('[data-f="rusak"]'),
  }));
  const clampInt = (v, max) => Math.max(0, Math.min(max, parseInt(v, 10) || 0));

  window.openReturValidasi = function (btn) {
    const r = rowsById.get(String(btn.dataset.id));
    if (!r) return;
    valRow = r;
    const saved = new Map((r.retur_items || []).map((it) => [String(it.sku).toUpperCase(), it]));
    const tidakLama = r.validated && r.retur_kondisi === 'tidak_sesuai'; // validasi lama tanpa rincian
    $('rvTitle').textContent = r.validated ? 'Koreksi validasi retur' : 'Validasi retur';
    $('rvSubtitle').textContent = `${r.no_pesanan} · ${r.no_resi || '-'}`;
    const numStyle = 'width:74px; margin:0; padding:6px 8px; text-align:center;';
    $('rvItems').innerHTML = (r.items || []).map((it) => {
      const s = saved.get(String(it.sku).toUpperCase());
      const balik = s ? clampInt(s.qty_balik, it.qty) : tidakLama ? 0 : it.qty;
      const rusak = s ? clampInt(s.qty_rusak, balik) : 0;
      return `<tr data-sku="${estEsc(it.sku)}" data-pesan="${it.qty}">
        <td><b>${estEsc(it.sku)}</b></td>
        <td style="text-align:center;">${estNum(it.qty)}</td>
        <td style="text-align:center;"><input type="number" inputmode="numeric" min="0" max="${it.qty}" step="1" value="${balik}" data-f="balik" style="${numStyle}" oninput="returValRecalc()" aria-label="Pcs balik ${estEsc(it.sku)}"></td>
        <td style="text-align:center;"><input type="number" inputmode="numeric" min="0" max="${it.qty}" step="1" value="${rusak}" data-f="rusak" style="${numStyle}" oninput="returValRecalc()" aria-label="Pcs rusak ${estEsc(it.sku)}"></td>
        <td style="text-align:center;"><b data-f="masuk"></b></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="empty-state">SKU pesanan ini tidak terbaca.</td></tr>';
    const noItems = !(r.items || []).length;
    $('rvKondisiWrap').style.display = noItems ? 'block' : 'none';
    $('rvKondisi').value = r.retur_kondisi === 'tidak_sesuai' && r.validated ? 'tidak_sesuai' : 'sesuai';
    const cur = r.retur_masalah || '';
    const opts = !cur || masalahList.includes(cur) ? masalahList : [cur, ...masalahList];
    $('rvMasalah').innerHTML = '<option value="">— pilih —</option>' + opts.map((m) => `<option${m === cur ? ' selected' : ''}>${estEsc(m)}</option>`).join('');
    $('rvCatatan').value = r.retur_catatan || '';
    $('rvMsg').textContent = '';
    $('rvSubmitBtn').disabled = false;
    window.returValRecalc();
    $('returValOverlay').style.display = 'flex';
  };

  window.closeReturValidasi = function () {
    $('returValOverlay').style.display = 'none';
    valRow = null;
  };

  window.returValPreset = function (mode) {
    valInputs().forEach((x) => { x.balik.value = mode === 'semua' ? x.pesan : 0; x.rusak.value = 0; });
    window.returValRecalc();
  };

  // Hitung ulang "masuk stok" + hasil (Sesuai / Tidak sesuai) tiap angka diubah.
  window.returValRecalc = function () {
    const rows = valInputs();
    let pesan = 0, balik = 0, rusak = 0;
    rows.forEach((x) => {
      const b = clampInt(x.balik.value, x.pesan);
      const ru = clampInt(x.rusak.value, b);
      // Angka di luar batas langsung dirapikan (kecuali kotak yang lagi dikosongkan buat diketik ulang).
      if (x.balik.value !== '' && String(b) !== x.balik.value) x.balik.value = b;
      if (x.rusak.value !== '' && String(ru) !== x.rusak.value) x.rusak.value = ru;
      x.rusak.max = b;
      x.tr.querySelector('[data-f="masuk"]').textContent = estNum(b - ru);
      pesan += x.pesan; balik += b; rusak += ru;
    });
    const sesuai = rows.length ? balik === pesan && rusak === 0 : $('rvKondisi').value === 'sesuai';
    $('rvMasalahWrap').style.display = sesuai ? 'none' : 'block';
    const ringkas = rows.length ? `Balik ${estNum(balik)} dari ${estNum(pesan)} pcs${rusak ? `, rusak ${estNum(rusak)} pcs` : ''} — masuk stok ${estNum(balik - rusak)} pcs.` : '';
    $('rvHasil').innerHTML = `<span class="badge ${sesuai ? 'badge-ok' : 'badge-danger'}">Hasil: ${sesuai ? 'Sesuai' : 'Tidak sesuai'}</span> <span class="hint">${ringkas}</span>`;
    return sesuai;
  };

  window.submitReturValidasi = async function () {
    if (!valRow) return;
    const sesuai = window.returValRecalc();
    const masalah = $('rvMasalah').value;
    const msg = $('rvMsg');
    if (!sesuai && !masalah) { msg.textContent = 'Pilih dulu kenapa retur ini tidak sesuai.'; $('rvMasalah').focus(); return; }
    const rows = valInputs();
    const body = {
      items: rows.map((x) => { const b = clampInt(x.balik.value, x.pesan); return { sku: x.sku, balik: b, rusak: clampInt(x.rusak.value, b) }; }),
      masalah: sesuai ? '' : masalah,
      catatan: $('rvCatatan').value,
    };
    if (!rows.length) body.kondisi = $('rvKondisi').value;
    const btn = $('rvSubmitBtn');
    btn.disabled = true;
    msg.textContent = '';
    try {
      const data = await api('/retur/' + valRow.id + '/validate', { method: 'POST', body: JSON.stringify(body) });
      say(`${data.no_pesanan}: ${data.message}`, data.detail_saved === false ? 'info' : 'ok');
      window.closeReturValidasi();
      loadRetur();
    } catch (e) {
      msg.textContent = e.message || 'Gagal memvalidasi retur';
      btn.disabled = false;
    }
  };

  // Export daftar retur (rentang tanggal + pencarian yang lagi dipakai, semua halaman) ke Excel.
  window.exportReturExcel = async function () {
    const btn = $('returExportBtn');
    const msg = $('returExportMsg');
    const params = new URLSearchParams({ from: state.from, to: state.to });
    if (state.q) params.set('q', state.q);
    btn.disabled = true;
    msg.textContent = 'Menyiapkan file...';
    try {
      const token = getToken();
      const res = await fetch('/api/retur/export?' + params.toString(), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.status === 401) { clearSession(); window.location.href = '/login.html'; return; }
      if (!res.ok) {
        let errMsg = 'Gagal export data';
        try { errMsg = (await res.json()).error || errMsg; } catch (e) { /* abaikan */ }
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      const m = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m ? m[1] : `Retur_${state.from}_sd_${state.to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      msg.textContent = 'File berhasil di-download';
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };

  window.cancelRetur = async function (btn) {
    const no = btn.dataset.no;
    if (!confirm(`Batalkan retur pesanan ${no}?\n\nPesanan kembali dihitung di Estimasi Penghasilan, dan stok yang sempat dikembalikan ditarik lagi.`)) return;
    btn.disabled = true;
    try {
      await api('/retur/' + btn.dataset.id, { method: 'DELETE' });
      say('Retur dibatalkan: ' + no, 'ok');
      loadRetur();
    } catch (e) {
      say(e.message || 'Gagal membatalkan retur', 'err');
      btn.disabled = false;
    }
  };

  // Halaman dibuka langsung di ?tab=retur: showPanel() di dashboard.js sudah jalan SEBELUM file
  // ini selesai dimuat, jadi initRetur() dipanggil dari sini.
  const panel = $('panel-retur');
  if (panel && panel.style.display !== 'none') window.initRetur();
})();
