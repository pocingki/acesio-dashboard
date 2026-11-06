// Ikon notifikasi (lonceng) di topbar akun user: tugas baru, diubah, dijalani, selesai, dibatalkan.
// Modul ini tidak menyentuh document/window saat dimuat (fungsi murni bisa dites di Node).
import { api } from './api.js';
import { h, icon, toast, dayInTz, fmtDate } from './ui.js';

export const POLL_MS = 45_000;

// ---------- fungsi murni (diekspor untuk tes) ----------

const TYPES = {
  tugas_baru: { title: 'Tugas baru', tone: 'baru' },
  tugas_diubah: { title: 'Jadwal diubah', tone: 'diubah' },
  tugas_berjalan: { title: 'Tugas sedang dijalani', tone: 'berjalan' },
  tugas_selesai: { title: 'Tugas selesai', tone: 'selesai' },
  tugas_disetujui: { title: 'Pekerjaan disetujui, isi SOAP', tone: 'selesai' },
  tugas_dibatalkan: { title: 'Tugas dibatalkan', tone: 'batal' },
  perlu_approve: { title: 'Perlu approve terapis', tone: 'menunggu' },
};

// Judul tipe, isi, dan nada warna untuk satu notifikasi. Tipe tak dikenal memakai judul dari server.
export function notificationText(n) {
  const t = TYPES[n?.type];
  return {
    title: t ? t.title : (n?.title || 'Notifikasi'),
    body: String(n?.body || ''),
    tone: t ? t.tone : 'baru',
  };
}

function dayNumber(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 : NaN;
}

// "baru saja", "5 menit lalu", "3 jam lalu", "kemarin", "3 hari lalu", lalu tanggal lengkap.
// Di bawah 24 jam memakai menit/jam; selebihnya batas hari mengikuti zona aplikasi (setTz di ui.js).
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  const sec = Math.round((now - t) / 1000);
  if (sec < 60) return 'baru saja';
  if (sec < 3600) return `${Math.floor(sec / 60)} menit lalu`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} jam lalu`;
  const days = dayNumber(dayInTz(new Date(now))) - dayNumber(dayInTz(new Date(t)));
  if (days === 1) return 'kemarin';
  if (days < 7) return `${days} hari lalu`;
  return fmtDate(iso);
}

// Isi lencana: kosong bila 0, "9+" bila lebih dari 9.
export function badgeText(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n === 0 ? '' : n > 9 ? '9+' : String(n);
}

export function bellLabel(count) {
  return `Notifikasi, ${Math.max(0, Math.floor(Number(count) || 0))} belum dibaca`;
}

// ---------- komponen ----------

let counter = 0;

// Mengembalikan elemen untuk `actions` shell. Elemen punya metode `dispose()` yang menghentikan
// polling, membatalkan permintaan, dan melepas semua listener dokumen. Panggil saat sesi berakhir.
export function notificationBell({ goTo, pollMs = POLL_MS } = {}) {
  const panelId = `notify-panel-${++counter}`;
  let disposed = false;
  let stopped = false; // sesi habis (401): jangan polling lagi
  let open = false;
  let unread = 0;
  let items = [];
  let state = 'idle'; // idle | loading | error | ready
  let timer = 0;
  let fetchCtl = null;
  const actionCtl = new AbortController();
  let markingAll = false;

  const badge = h('span', { class: 'notify__badge', 'aria-hidden': 'true', hidden: true });
  const btn = h('button', {
    class: 'icon-btn notify__btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-controls': panelId, 'aria-label': bellLabel(0), onclick: () => (open ? close(true) : openPanel()),
  }, icon('bell', 20), badge);

  const markAll = h('button', { class: 'notify__markall', type: 'button', disabled: true, onclick: onMarkAll }, 'Tandai semua dibaca');
  const body = h('div', { class: 'notify__body' });
  const panel = h('div', { class: 'notify__panel', id: panelId, role: 'dialog', 'aria-label': 'Notifikasi', hidden: true },
    h('div', { class: 'notify__head' }, h('strong', null, 'Notifikasi'), markAll),
    body);
  const root = h('div', { class: 'notify' }, btn, panel);

  const visible = () => document.visibilityState !== 'hidden';

  function setUnread(n) {
    unread = Math.max(0, Math.floor(Number(n) || 0));
    const text = badgeText(unread);
    badge.textContent = text;
    badge.hidden = text === '';
    btn.setAttribute('aria-label', bellLabel(unread));
    markAll.disabled = markingAll || unread === 0;
  }

  // ----- isi panel -----
  function renderBody() {
    if (state === 'loading' || (state === 'idle' && open)) {
      body.replaceChildren(h('p', { class: 'notify__note', role: 'status' }, 'Memuat…'));
    } else if (state === 'error') {
      body.replaceChildren(h('div', { class: 'notify__note', role: 'alert' },
        h('p', null, 'Notifikasi belum bisa dimuat.'),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => load() }, 'Coba lagi')));
    } else if (!items.length) {
      body.replaceChildren(h('p', { class: 'notify__note' }, 'Belum ada notifikasi.'));
    } else {
      const now = Date.now();
      body.replaceChildren(h('ul', { class: 'notify__list' }, ...items.map((n) => {
        const t = notificationText(n);
        return h('li', null, h('button', {
          class: `notify__item${n.read ? '' : ' is-unread'}`, type: 'button', 'data-tone': t.tone, onclick: () => choose(n),
        },
        h('span', { class: 'notify__bar', 'aria-hidden': 'true' }),
        h('span', { class: 'notify__text' },
          h('span', { class: 'notify__title' }, t.title, n.read ? null : h('span', { class: 'sr-only' }, ' (belum dibaca)')),
          t.body ? h('span', { class: 'notify__desc' }, t.body) : null,
          h('time', { class: 'notify__time', datetime: n.created_at }, relativeTime(n.created_at, now))),
        n.read ? null : h('span', { class: 'notify__dot', 'aria-hidden': 'true' })));
      })));
    }
  }

  // ----- pengambilan data -----
  // full=false: hanya jumlah belum dibaca (polling saat panel tertutup); full=true: daftar lengkap.
  async function fetchNow(full) {
    if (disposed || stopped) return;
    if (fetchCtl) fetchCtl.abort();
    const mine = new AbortController();
    fetchCtl = mine;
    try {
      const d = await api(`/api/my/notifications?limit=${full ? 30 : 1}`, { signal: mine.signal });
      if (disposed || mine.signal.aborted) return;
      setUnread(d.unread);
      if (full) {
        items = Array.isArray(d.notifications) ? d.notifications : [];
        state = 'ready';
        if (open) renderBody();
      }
    } catch (e) {
      if (disposed || mine.signal.aborted || e?.aborted || e?.name === 'AbortError') return;
      if (e?.status === 401) { stopped = true; return; }
      if (full) { state = 'error'; if (open) renderBody(); } // polling gagal: diam
    } finally {
      if (fetchCtl === mine) fetchCtl = null;
    }
  }

  function load() {
    state = 'loading';
    renderBody();
    return fetchNow(true);
  }

  // ----- polling: hanya saat tab browser terlihat -----
  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (disposed || stopped || !visible()) return;
    timer = setTimeout(tick, pollMs);
  }
  async function tick() {
    timer = 0;
    if (disposed || stopped || !visible()) return;
    await fetchNow(open);
    schedule();
  }
  function onVisibility() {
    if (disposed) return;
    clearTimeout(timer);
    timer = 0;
    if (!visible()) {
      if (fetchCtl) fetchCtl.abort();
      return;
    }
    tick(); // langsung segar saat tab kembali terlihat
  }
  document.addEventListener('visibilitychange', onVisibility);

  // ----- buka / tutup -----
  function onOutside(e) {
    if (!root.contains(e.target)) close(root.contains(document.activeElement));
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(true); }
  }
  function onFocusOut(e) {
    // Tab keluar dari lonceng/panel: tutup tanpa merebut fokus.
    if (open && e.relatedTarget && !root.contains(e.relatedTarget)) close(false);
  }
  root.addEventListener('focusout', onFocusOut);

  function openPanel() {
    if (open || disposed) return;
    open = true;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    if (state === 'ready') renderBody(); else { state = 'loading'; renderBody(); }
    fetchNow(true); // tampilkan data lama dulu, segarkan di latar
  }
  function close(restoreFocus) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
    if (restoreFocus && !disposed) btn.focus();
  }

  // ----- aksi -----
  function markRead(payload) {
    return api('/api/my/notifications/read', { method: 'POST', body: payload, signal: actionCtl.signal })
      .then((r) => { if (!disposed && r && Number.isFinite(r.unread)) setUnread(r.unread); return r; });
  }

  function choose(n) {
    close(true);
    if (!n.read) {
      n.read = true;
      setUnread(unread - 1);
      markRead({ ids: [n.id] }).catch(() => { /* polling berikutnya meluruskan jumlahnya */ });
    }
    if (typeof goTo === 'function') goTo('schedule', n.day ? { day: n.day } : {});
  }

  async function onMarkAll() {
    if (markingAll || disposed) return;
    markingAll = true;
    markAll.disabled = true;
    try {
      await markRead({ all: true });
      if (disposed) return;
      for (const n of items) n.read = true;
      setUnread(0);
      if (open) renderBody();
    } catch (e) {
      if (!disposed && !e?.aborted) toast(e?.message || 'Gagal menandai notifikasi', 'err');
    } finally {
      markingAll = false;
      if (!disposed) markAll.disabled = unread === 0;
    }
  }

  function dispose() {
    if (disposed) return;
    close(false);
    disposed = true;
    clearTimeout(timer);
    timer = 0;
    if (fetchCtl) fetchCtl.abort();
    fetchCtl = null;
    actionCtl.abort();
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
    root.removeEventListener('focusout', onFocusOut);
  }
  root.dispose = dispose;

  renderBody();
  tick(); // ambil jumlah awal lalu jadwalkan polling berikutnya
  return root;
}
