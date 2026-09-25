// A stand-in for the Five More Minutes plugin API, for tests: the same routes, the same answers, over
// real HTTP. It is small and deliberately faithful to docs/plugins/api-v1.md rather than clever, so that
// a test failing here means the plugin misunderstood the API, not that the mock did.

import { createServer } from 'node:http';

export const KEY = `fmmk_${'0123456789abcdef'.repeat(2)}_${'A'.repeat(43)}`;
export const ALL = ['state:read', 'timer:start', 'timer:extend', 'timer:stop', 'timer:cancel'];

const problem = (status, title, detail, type) => ({ status, body: { type: type ?? 'about:blank', title, status, detail } });

/**
 * @param {{ scopes?: string[], key?: string, localOnly?: boolean, limit?: number }} [options]
 */
export async function startMock({ scopes = ALL, key = KEY, localOnly = false, limit = Infinity } = {}) {
  const now = () => new Date();
  const iso = (d) => d.toISOString();

  const world = {
    signal: 0,
    online: true,
    timer: null,
    lock: null,
    requests: [],
    failNext: 0,
  };

  /** @type {Array<() => void>} */
  let waiters = [];
  const changed = () => {
    world.signal += 1;
    const ready = waiters;
    waiters = [];
    ready.forEach((wake) => wake());
  };

  const secondsUntil = (d) => Math.max(0, Math.ceil((Date.parse(d) - now().getTime()) / 1000));

  const view = () => ({
    apiVersion: 1,
    serverTime: iso(now()),
    signal: world.signal,
    device: { id: '11111111-1111-1111-1111-111111111111', name: 'Elliots laptop', online: world.online },
    timer: world.timer && { ...world.timer, secondsLeft: secondsUntil(world.timer.endsAt) },
    lock: world.lock && { ...world.lock, secondsLeft: secondsUntil(world.lock.endsAt) },
  });

  const need = (scope) => scopes.includes(scope)
    ? null
    : problem(403, 'Permission missing', `This key does not have the ${scope} permission.`);

  const start = (minutes, message) => {
    if (world.timer) return problem(409, 'Not possible right now', 'Time is already running on that computer. Add to it instead.');
    if (!minutes || minutes < 1) return problem(400, 'Cannot do that', 'Say how long: a number of minutes, or a time to stop at.');
    world.lock = null;
    const at = now();
    world.timer = { id: `t${world.signal + 1}`, startsAt: iso(at), endsAt: iso(new Date(at.getTime() + minutes * 60_000)), message: message ?? null };
    changed();
    return { status: 200, body: view() };
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    world.requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, body: text ? JSON.parse(text) : null });

    const send = ({ status, body }, headers = {}) => {
      response.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };

    if (world.failNext > 0) {
      world.failNext -= 1;
      return send(problem(500, 'Boom', 'Something broke.'));
    }

    if (localOnly) {
      return send(problem(403, 'Local network only', 'Integration keys work only from the local network.', 'https://fivemoreminutes.app/problems/local-network-only'));
    }

    if (world.requests.length > limit) {
      return send(problem(429, 'Too many requests', 'Slow down.'), { 'retry-after': '1' });
    }

    if (request.headers.authorization !== `Bearer ${key}`) return send(problem(401, 'Unauthorized', 'nope'));

    const route = `${request.method} ${url.pathname.replace('/api/integrations/v1', '')}`;
    const body = text ? JSON.parse(text) : {};

    switch (route) {
      case 'GET /me':
        return send({ status: 200, body: { apiVersion: 1, key: { id: 'k1', name: 'Test key', pluginId: null, scopes, createdAt: iso(now()), expiresAt: null, lastUsedAt: null }, device: { id: '11111111-1111-1111-1111-111111111111', name: 'Elliots laptop' } } });

      case 'GET /state': {
        const denied = need('state:read');
        if (denied) return send(denied);

        const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : -1;
        const wait = Number(url.searchParams.get('wait') ?? 0);

        if (wait > 0 && since === world.signal) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.min(wait, 25) * 1000);
            waiters.push(() => { clearTimeout(timer); resolve(); });
            response.on('close', () => clearTimeout(timer));
          });
        }

        return send({ status: 200, body: view() });
      }

      case 'POST /timer/start':
        // `until` is a clock time in the household's zone; the mock just treats it as an hour away.
        return send(need('timer:start') ?? start(body.minutes ?? (body.until ? 60 : 0), body.message));

      case 'POST /timer/extend': {
        const denied = need('timer:extend');
        if (denied) return send(denied);
        if (!world.timer) return send(problem(409, 'Not possible right now', 'Nothing is running on that computer.'));
        world.timer.endsAt = iso(new Date(Date.parse(world.timer.endsAt) + (body.minutes ?? 5) * 60_000));
        changed();
        return send({ status: 200, body: view() });
      }

      case 'POST /timer/stop': {
        const denied = need('timer:stop');
        if (denied) return send(denied);
        if (!world.timer) return send(problem(409, 'Not possible right now', 'Nothing is running on that computer.'));
        world.timer = null;
        const at = now();
        world.lock = { startsAt: iso(at), endsAt: iso(new Date(at.getTime() + 30 * 60_000)), mode: 'Network' };
        changed();
        return send({ status: 200, body: view() });
      }

      case 'POST /timer/cancel': {
        const denied = need('timer:cancel');
        if (denied) return send(denied);
        if (!world.timer) return send(problem(409, 'Not possible right now', 'Nothing is running on that computer.'));
        world.timer = null;
        changed();
        return send({ status: 200, body: view() });
      }

      default:
        return send(problem(404, 'Not found', 'No such route.'));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    world,
    /** What a parent pressing a button would do, so a test can make something happen. */
    parentStarts: (minutes, message) => start(minutes, message),
    parentLocks: (minutes = 30) => { const at = now(); world.timer = null; world.lock = { startsAt: iso(at), endsAt: iso(new Date(at.getTime() + minutes * 60_000)), mode: 'Network' }; changed(); },
    parentLifts: () => { world.lock = null; changed(); },
    setOnline: (online) => { world.online = online; changed(); },
    close: () => { waiters.forEach((wake) => wake()); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}
