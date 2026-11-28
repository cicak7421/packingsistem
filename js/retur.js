// Tab "Retur" di dashboard (admin & CS). Backend: api/_lib/routes/retur.js.
// Dimuat setelah dashboard.js, jadi boleh pakai helper-nya (api, estEsc, estNum, estRupiah, formatSkuChips, toast).
(function () {
  'use strict';

  const state = { page: 1, totalPages: 1, from: '', to: '', q: '', seq: 0, inited: false };
  let searchTimer = null;
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
    if (!sel || !list || !list.length || sel.options.length === list.length) return;
    sel.innerHTML = list.map((a) => `<option>${estEsc(a)}</option>`).join('');
  }

  window.initRetur = function () {
    if (!state.inited) {
      state.inited = true;
      state.to = wibToday();
      state.from = addDays(state.to, -29);
      $('returFrom').value = state.from;
      $('returTo').value = state.to;
    }
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
      $('returNotice').innerHTML = data.ready === false
        ? `<div class="card" style="border-color:var(--warn);"><b>Fitur retur belum aktif.</b> <span class="hint">${estEsc(data.message || '')}</span></div>`
        : '';
      const s = data.summary || {};
      $('returTotal').textContent = estNum(s.total);
      $('returNilai').textContent = estRupiah(s.nilai);
      $('returBagus').textContent = estNum(s.bagus);
      $('returRusak').textContent = estNum(s.rusak);

      state.totalPages = data.total_pages || 1;
      if (!data.returs.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Belum ada retur di rentang tanggal ini.</td></tr>';
      } else {
        tbody.innerHTML = data.returs.map((r) => {
          const rusak = r.retur_kondisi === 'rusak';
          return `<tr>
            <td style="white-space:nowrap;">${estEsc(fmtTime(r.retur_at))}</td>
            <td>${estEsc(r.no_pesanan)}<div class="hint">${estEsc(r.no_resi || '-')}</div></td>
            <td>${estEsc(r.toko || '-')}</td>
            <td>${typeof formatSkuChips === 'function' ? formatSkuChips(r.sku) : estEsc(r.sku)}</td>
            <td><span class="badge ${rusak ? 'badge-danger' : 'badge-ok'}">${rusak ? 'Rusak' : 'Bagus'}</span></td>
            <td>${estEsc(r.retur_alasan || '-')}${r.retur_catatan ? `<div class="hint">${estEsc(r.retur_catatan)}</div>` : ''}</td>
            <td>${estEsc(r.retur_by_name || '-')}</td>
            <td style="text-align:right;"><b>${estRupiah(r.nilai)}</b></td>
            <td style="text-align:right;"><button type="button" class="btn-outline" style="width:auto; margin:0; padding:6px 10px;" data-id="${r.id}" data-no="${estEsc(r.no_pesanan)}" onclick="cancelRetur(this)">Batalkan</button></td>
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
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${estEsc(e.message)}</td></tr>`;
    }
  }

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

  window.onReturDateChange = function () {
    const from = $('returFrom').value;
    const to = $('returTo').value;
    if (!from || !to) return;
    if (from > to) { say('Tanggal awal tidak boleh setelah tanggal akhir', 'err'); return; }
    state.from = from; state.to = to; state.page = 1;
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
        body: JSON.stringify({ value, kondisi: $('returKondisi').value, alasan: $('returAlasan').value, catatan: $('returCatatan').value }),
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
