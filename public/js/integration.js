// Menu samping "Integrasi" (khusus supervisor): hubungkan Acesio ke WhatsApp lewat Amnan dalam 3 langkah.
// Bahasa sengaja awam: tidak ada istilah teknis (API, webhook, token) di layar utama.
import { api } from './api.js';
import { h, icon, openModal, toast, confirmDialog, fmtDate } from './ui.js';

// ---------- fungsi murni (diekspor untuk tes) ----------

// "AMN1.<base64url JSON>" -> alamat Amnan di dalam kode, atau '' bila bukan kode sambungan.
export function urlFromCode(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (!/^AMN1\./i.test(s)) return '';
  try {
    const b64 = s.slice(5).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const u = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))).u;
    return typeof u === 'string' ? u : '';
  } catch {
    return '';
  }
}

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return 'baru saja';
  if (sec < 3600) return `${Math.floor(sec / 60)} menit lalu`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} jam lalu`;
  return fmtDate(iso);
}

// Judul + penjelasan banner status menurut keadaan.
export function statusInfo(s, now = Date.now()) {
  const waiting = s.stats?.pending ? ` ${s.stats.pending} kiriman sedang menunggu.` : '';
  if (s.status === 'none') return { tone: 'off', title: 'Belum tersambung', text: 'Ikuti 3 langkah di bawah. Cukup beberapa menit.' };
  if (s.status === 'paused') return { tone: 'wait', title: 'Tersambung, belum dinyalakan', text: 'Lanjut ke langkah 3 untuk mulai mengirim.' };
  if (s.status === 'problem') {
    const failed = s.stats?.failed ? `${s.stats.failed} kiriman gagal. ` : '';
    return { tone: 'bad', title: 'Perlu perhatian', text: `${s.last_error ? `${s.last_error}. ` : ''}${failed}${waiting}`.trim() };
  }
  const last = s.stats?.last_ok_at ? `Terakhir terkirim ${ago(s.stats.last_ok_at, now)}.` : 'Menunggu kunjungan pertama dicatat.';
  return { tone: 'ok', title: 'Berjalan lancar', text: `${last}${waiting}` };
}

const WA_TEXT = {
  connected: ['ok', 'WhatsApp di Amnan tersambung'],
  qr: ['wait', 'WhatsApp di Amnan menunggu pindai QR'],
  connecting: ['wait', 'WhatsApp di Amnan sedang menyambung'],
  disconnected: ['bad', 'WhatsApp di Amnan belum tersambung. Buka Amnan dan pindai QR.'],
};
export const waText = (st) => WA_TEXT[st] || ['wait', 'Status WhatsApp belum diketahui'];

const ITEM_LABEL = { sent: ['ok', 'Terkirim'], pending: ['wait', 'Menunggu'], failed: ['late', 'Gagal'], skipped: ['off', 'Dilewati'] };

// ---------- tombol di topbar ----------

const DOT_LABEL = { none: 'belum tersambung', paused: 'tersambung, belum dinyalakan', on: 'berjalan', problem: 'perlu perhatian' };

export function integrationButton() {
  const dot = h('span', { class: 'intg-dot', 'data-status': 'none', 'aria-hidden': 'true' });
  const sr = h('span', { class: 'sr-only' }, '');
  const btn = h('button', { class: 'intg-btn', type: 'button', onclick: () => openIntegrationDrawer(setDot) },
    icon('link', 18), h('span', null, 'Integrasi'), dot, sr);
  function setDot(s) {
    const st = s?.status || 'none';
    dot.dataset.status = st;
    sr.textContent = ` (${DOT_LABEL[st] || ''})`;
    btn.title = `Integrasi WhatsApp: ${DOT_LABEL[st] || ''}`;
  }
  api('/api/sv/integration').then(setDot).catch(() => { /* titik tetap abu-abu */ });
  return btn;
}

// ---------- panel samping ----------

function toggle({ id, label, desc, on, disabled, onChange }) {
  const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `${id}-l`, 'aria-describedby': desc ? `${id}-d` : null, disabled: disabled || null },
    h('span', { class: 'switch__knob' }));
  sw.addEventListener('click', () => onChange(!on, sw));
  return h('div', { class: `intg-row${disabled ? ' is-disabled' : ''}` },
    h('div', { class: 'intg-row__text' }, h('b', { id: `${id}-l` }, label), desc ? h('p', { id: `${id}-d`, class: 'hint' }, desc) : null),
    sw);
}

function step({ n, title, done, locked, children }) {
  const body = h('div', { class: 'intg-step__body' }, children);
  if (locked) body.setAttribute('inert', '');
  return h('li', { class: `intg-step${done ? ' is-done' : ''}${locked ? ' is-locked' : ''}` },
    h('div', { class: 'intg-step__head' },
      h('span', { class: 'intg-step__num', 'aria-hidden': 'true' }, done ? icon('check', 16) : String(n)),
      h('h3', null, title),
      done ? h('span', { class: 'pill pill--ok' }, 'Selesai') : null,
      locked ? h('span', { class: 'pill pill--off' }, 'Selesaikan langkah sebelumnya') : null),
    body);
}

export function openIntegrationDrawer(onState) {
  const body = h('div', { class: 'intg' });
  let current = null;
  let busy = false;

  const modal = openModal({ title: 'Hubungkan ke WhatsApp', content: body, size: 'drawer', onClose: () => { if (current && onState) onState(current); } });

  async function run(fn, { ok } = {}) {
    if (busy) return;
    busy = true;
    body.setAttribute('aria-busy', 'true');
    try {
      const s = await fn();
      if (s) { current = s; if (onState) onState(s); render(s); }
      if (ok) toast(typeof ok === 'function' ? ok(s) : ok);
      return s;
    } catch (e) {
      if (!e.aborted) toast(e.message, 'err');
      return null;
    } finally {
      busy = false;
      body.removeAttribute('aria-busy');
    }
  }

  const put = (patch) => api('/api/sv/integration', { method: 'PUT', body: patch });

  function flow(s) {
    const live = s.status === 'on';
    const node = (name, sub) => h('div', { class: 'intg-node' }, h('b', null, name), h('span', null, sub));
    const arrow = h('div', { class: `intg-arrow${live ? ' is-live' : ''}`, 'aria-hidden': 'true' }, h('span', null, 'otomatis'));
    return h('div', { class: 'intg-flow', role: 'img', 'aria-label': 'Terapis mencatat layanan di Acesio, otomatis diteruskan ke Amnan, lalu tampil di chat WhatsApp pelanggan' },
      node('Acesio', 'Terapis mencatat layanan'), arrow, node('Amnan', 'Pusat chat WhatsApp'), arrow.cloneNode(true), node('Pelanggan', 'Riwayat kunjungan tampil di chat'));
  }

  function banner(s) {
    const info = statusInfo(s);
    const retry = s.stats.failed > 0
      ? h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => run(() => api('/api/sv/integration/retry', { method: 'POST' }), { ok: 'Mengirim ulang…' }) }, `Kirim ulang ${s.stats.failed} yang gagal`)
      : null;
    return h('div', { class: `intg-banner intg-banner--${info.tone}`, role: 'status' },
      h('span', { class: 'intg-banner__dot', 'aria-hidden': 'true' }),
      h('div', null, h('b', null, info.title), info.text ? h('p', null, info.text) : null, retry));
  }

  function connectForm() {
    const code = h('textarea', { class: 'textarea', id: 'intg-code', rows: 2, spellcheck: 'false', autocomplete: 'off', placeholder: 'Tempel kode dari Amnan di sini' });
    const url = h('input', { class: 'input', id: 'intg-url', type: 'url', autocomplete: 'off', placeholder: 'https://wa.klinikanda.id' });
    const err = h('p', { class: 'error', role: 'alert' });
    const go = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Sambungkan');
    code.addEventListener('input', () => {
      const u = urlFromCode(code.value);
      if (u && !url.dataset.touched) url.value = u;
    });
    url.addEventListener('input', () => { url.dataset.touched = '1'; });
    const form = h('form', { novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'intg-code' }, 'Kode sambungan'), code,
        h('p', { class: 'hint' }, 'Minta ke admin Amnan (menu Integrasi). Kodenya diawali AMN1. atau amk_.')),
      h('div', { class: 'field' }, h('label', { for: 'intg-url' }, 'Alamat Amnan'), url,
        h('p', { class: 'hint' }, 'Terisi otomatis dari kode. Kalau Amnan ada di server yang sama dengan Acesio, isi http://127.0.0.1:8080')),
      err, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!code.value.trim()) { err.textContent = 'Tempel kode sambungan dulu.'; code.focus(); return; }
      go.disabled = true;
      go.textContent = 'Menyambungkan…';
      try {
        const s = await api('/api/sv/integration/connect', { method: 'POST', body: { code: code.value, url: url.value } });
        current = s;
        if (onState) onState(s);
        render(s);
        toast('Tersambung ke Amnan');
      } catch (ex) {
        if (!ex.aborted) err.textContent = ex.message;
        go.disabled = false;
        go.textContent = 'Sambungkan';
      }
    });
    return form;
  }

  function connectedView(s) {
    const [wTone, wText] = waText(s.wa_status);
    return h('div', null,
      h('dl', { class: 'intg-kv' },
        h('dt', null, 'Tersambung ke'), h('dd', null, s.brand || s.url),
        h('dt', null, 'Alamat'), h('dd', { class: 'break' }, s.url),
        h('dt', null, 'Kunci akses'), h('dd', { class: 'break' }, s.key_hint)),
      h('p', { class: `intg-note intg-note--${wTone}` }, wText),
      h('div', { class: 'intg-actions' },
        h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => run(async () => {
          const r = await api('/api/sv/integration/test', { method: 'POST' });
          toast(r.test.ok ? 'Sambungan baik' : r.test.message, r.test.ok ? 'ok' : 'err');
          return r;
        }) }, 'Tes sambungan'),
        h('button', { class: 'btn btn--sm btn--danger', type: 'button', onclick: async () => {
          if (!(await confirmDialog('Putuskan sambungan ke Amnan? Kunjungan berikutnya tidak akan dikirim, dan kiriman yang masih menunggu dibatalkan.', { confirmText: 'Ya, putuskan', danger: true }))) return;
          run(() => api('/api/sv/integration/disconnect', { method: 'POST' }), { ok: 'Sambungan diputus' });
        } }, 'Putuskan')));
  }

  function chooseView(s) {
    const text = h('textarea', { class: 'textarea', id: 'intg-thanks', rows: 3, maxlength: 500 }, s.thanks_text);
    const save = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => run(() => put({ thanks_text: text.value }), { ok: 'Ucapan disimpan' }) }, 'Simpan ucapan');
    return h('div', null,
      h('p', { class: 'hint' }, 'Pilihan bawaan sudah cocok untuk kebanyakan klinik. Boleh langsung lanjut ke langkah 3.'),
      toggle({
        id: 'intg-visit', label: 'Catat kunjungan di chat WhatsApp', on: s.send_visit,
        desc: 'Setiap layanan yang dicatat terapis ikut tampil di profil pelanggan di Amnan: nama, No RM, kunjungan ke-berapa, dan layanannya. Catatan Medis dan komisi tidak pernah dikirim.',
        onChange: (on) => run(() => put({ send_visit: on, ...(on ? {} : { send_thanks: false }) })),
      }),
      toggle({
        id: 'intg-thanks-sw', label: 'Kirim ucapan terima kasih', on: s.send_thanks, disabled: !s.send_visit || !s.can_message,
        desc: s.can_message
          ? 'Pesan WhatsApp otomatis, paling banyak sekali sehari per pelanggan. Nyalakan hanya bila pelanggan setuju menerima pesan.'
          : 'Kunci akses ini belum boleh mengirim pesan WhatsApp. Minta admin Amnan menambah izinnya, lalu tekan "Tes sambungan".',
        onChange: (on) => run(() => put({ send_thanks: on })),
      }),
      s.send_thanks ? h('div', { class: 'field intg-thanks' }, h('label', { for: 'intg-thanks' }, 'Isi ucapan'), text,
        h('p', { class: 'hint' }, 'Tulis {nama} untuk otomatis diganti nama pelanggan.'), save) : null);
  }

  function switchOnView(s) {
    return h('div', null,
      toggle({
        id: 'intg-on', label: s.enabled ? 'Integrasi menyala' : 'Integrasi mati', on: s.enabled, disabled: !s.send_visit && !s.enabled,
        desc: s.enabled
          ? 'Kunjungan yang dicatat mulai sekarang langsung dikirim ke Amnan.'
          : (s.send_visit ? 'Hanya kunjungan yang dicatat SETELAH dinyalakan yang dikirim. Data lama tidak ikut.' : 'Nyalakan "Catat kunjungan" di langkah 2 dulu.'),
        onChange: (on) => run(() => put({ enabled: on }), { ok: on ? 'Integrasi dinyalakan' : 'Integrasi dimatikan' }),
      }));
  }

  function activity(s) {
    const items = s.recent.length
      ? s.recent.map((r) => {
        const [tone, label] = ITEM_LABEL[r.status] || ['off', r.status];
        return h('li', { class: 'intg-item' },
          h('span', { class: `pill pill--${tone}` }, label),
          h('div', null,
            h('b', null, r.customer || 'Customer'), r.thanks && r.status === 'sent' ? h('span', { class: 'muted' }, ' · plus ucapan') : null,
            h('p', { class: 'hint' }, [r.services, ago(r.at)].filter(Boolean).join(' · ')),
            r.error && r.status !== 'sent' ? h('p', { class: 'intg-err' }, r.error) : null));
      })
      : [h('li', { class: 'hint' }, 'Belum ada kiriman. Akan muncul di sini setelah terapis mencatat layanan.')];
    return h('details', { class: 'intg-activity' },
      h('summary', null, `Aktivitas terakhir${s.stats.sent_24h ? ` (${s.stats.sent_24h} terkirim 24 jam terakhir)` : ''}`),
      h('ul', { class: 'intg-list' }, items),
      h('details', { class: 'intg-tech' }, h('summary', null, 'Info teknis'),
        h('p', { class: 'hint' }, s.amnan_can_read
          ? 'Arah sebaliknya (Amnan membaca data customer Acesio) sudah bisa dipakai: kunci server (BOT_API_KEY) aktif.'
          : 'Arah sebaliknya (Amnan membaca data customer Acesio) belum aktif: isi BOT_API_KEY di berkas .env server.')));
  }

  // Ringkasan 3 langkah sekali lihat; langkah aktif = yang pertama belum selesai.
  function progress(s) {
    const items = [['Sambungkan', s.connected], ['Pilih yang dikirim', s.connected && s.send_visit && s.enabled], ['Nyalakan', s.enabled]];
    const cur = items.findIndex(([, d]) => !d);
    return h('ol', { class: 'intg-progress', 'aria-label': 'Ringkasan langkah' },
      items.map(([label, done], i) => h('li', { class: done ? 'is-done' : (i === cur ? 'is-now' : '') },
        h('span', { class: 'intg-progress__n', 'aria-hidden': 'true' }, done ? icon('check', 12) : String(i + 1)), label,
        done ? h('span', { class: 'sr-only' }, ' (selesai)') : null)));
  }

  function render(s) {
    const x = s.connected;
    body.replaceChildren(
      flow(s),
      h('p', { class: 'intg-lead' }, 'Setiap layanan yang dicatat di Acesio otomatis tampil di riwayat chat WhatsApp pelanggan. Tim admin langsung tahu pelanggan sudah berkunjung berapa kali dan layanan apa.'),
      banner(s),
      progress(s),
      h('ol', { class: 'intg-steps' },
        step({ n: 1, title: 'Sambungkan ke Amnan', done: x, children: x ? connectedView(s) : connectForm() }),
        step({ n: 2, title: 'Pilih yang dikirim', done: false, locked: !x, children: x ? chooseView(s) : [h('p', { class: 'hint' }, 'Muncul setelah tersambung.')] }),
        step({ n: 3, title: 'Nyalakan', done: s.enabled, locked: !x, children: x ? switchOnView(s) : [h('p', { class: 'hint' }, 'Muncul setelah tersambung.')] })),
      x ? activity(s) : null);
  }

  body.append(h('p', { class: 'muted' }, 'Memuat…'));
  api('/api/sv/integration').then((s) => { current = s; if (onState) onState(s); render(s); })
    .catch((e) => { if (!e.aborted) body.replaceChildren(h('p', { class: 'error' }, e.message)); });
  return modal;
}
