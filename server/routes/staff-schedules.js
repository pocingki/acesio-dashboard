import { HttpError } from '../util.js';
import { clientIp } from '../auth.js';
import { add } from './index.js';
import { parseId, readPeriod, cleanQ } from './history.js';
import {
  SCHEDULE_STATUSES, listSchedules, listWorkers, getSchedule, createSchedule, updateSchedule, cancelSchedule,
} from '../schedules.js';

// Jadwal untuk staff (admin dan supervisor). Logika ada di server/schedules.js.
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

function readPage(query) {
  if (blank(query.page)) return 1;
  const s = String(query.page).trim();
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1) throw new HttpError(400, 'page harus berupa angka bulat positif');
  return Number(s);
}

function readStatus(query) {
  if (blank(query.status)) return undefined;
  const s = String(query.status).trim();
  if (!SCHEDULE_STATUSES.includes(s)) throw new HttpError(400, 'Status harus baru, berjalan, selesai, atau batal');
  return s;
}

add('GET', '/api/staff/schedules', 'staff', ({ query }) => {
  const { from, to } = readPeriod(query);
  return listSchedules({
    from, to,
    userId: blank(query.user_id) ? undefined : parseId(query.user_id, 'user_id'),
    status: readStatus(query),
    q: cleanQ(query.q),
    page: readPage(query),
  });
});

// Didaftarkan sebelum jalur :id; namanya sengaja berbeda supaya tidak bentrok dengan /api/staff/schedules/:id.
add('GET', '/api/staff/schedule-workers', 'staff', () => ({ workers: listWorkers() }));

add('GET', '/api/staff/schedules/:id', 'staff', ({ params }) => ({ schedule: getSchedule(parseId(params.id, 'ID jadwal')) }));

add('POST', '/api/staff/schedules', 'staff', ({ req, user, body }) => ({ schedule: createSchedule(body || {}, user, clientIp(req)) }));

add('PATCH', '/api/staff/schedules/:id', 'staff', ({ req, user, params, body }) => (
  { schedule: updateSchedule(parseId(params.id, 'ID jadwal'), body || {}, user, clientIp(req)) }
));

add('POST', '/api/staff/schedules/:id/cancel', 'staff', ({ req, user, params }) => (
  { schedule: cancelSchedule(parseId(params.id, 'ID jadwal'), user, clientIp(req)) }
));
