import { clientIp } from '../auth.js';
import { add } from './index.js';
import { requireWorker } from './helpers.js';
import { parseId, readPeriod } from './history.js';
import { listMine, getMine, startSchedule } from '../schedules.js';

// Jadwal milik user yang login. Admin/supervisor mendapat 403 (requireWorker).
// Logika ada di server/schedules.js.
const truthy = (v) => ['1', 'true'].includes(String(v ?? '').trim().toLowerCase());

add('GET', '/api/my/schedules', 'user', ({ user, query }) => {
  requireWorker(user);
  const { from, to } = readPeriod(query); // rentang terbalik -> 400
  return listMine(user.id, { from, to, all: truthy(query.all) });
});

add('GET', '/api/my/schedules/:id', 'user', ({ user, params }) => {
  requireWorker(user);
  return { schedule: getMine(user.id, parseId(params.id, 'ID jadwal')) };
});

add('POST', '/api/my/schedules/:id/start', 'user', ({ req, user, params }) => {
  requireWorker(user);
  return { schedule: startSchedule({ user, id: parseId(params.id, 'ID jadwal'), ip: clientIp(req) }) };
});
