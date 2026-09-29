import { validateConfig, randomToken, DEFAULT_SHADOWROCKET_CONF, UUID_PATTERN, WS_PATH } from './model.js';
import { generateMihomo, generateShadowrocketSubscription, generateShadowrocketConf } from './generate.js';
import { handleVlessWebSocket } from './ws.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const error = (message, status = 400) => json({ error: message }, status);
const key = id => `config:${id}`;
const validId = id => /^[0-9a-f]{24}$/.test(id);

function isAdmin(request, env) {
  return Boolean(env.ADMIN_SECRET && request.headers.get('authorization') === `Bearer ${env.ADMIN_SECRET}`);
}

function withRuntimeCf(config, secret) {
  return config.cf.mode === 'external'
    ? config
    : { ...config, cf: { ...config.cf, uuid: secret, wsPath: WS_PATH } };
}

async function fetchUpstream(url, agent) {
  if (!url) return { body: '', usage: '' };
  const response = await fetch(url, {
    headers: { 'user-agent': agent, accept: '*/*' },
    signal: AbortSignal.timeout(20000), redirect: 'follow'
  });
  if (!response.ok) throw new Error(`原订阅 HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 2_000_000) throw new Error('原订阅超过 2 MB');
  const body = await response.text();
  if (new TextEncoder().encode(body).length > 2_000_000) throw new Error('原订阅超过 2 MB');
  return { body, usage: response.headers.get('subscription-userinfo') || '' };
}

async function readConfig(env, id) {
  if (!validId(id)) return null;
  return env.CONFIGS.get(key(id), 'json');
}

async function handleAdmin(request, env, parts) {
  if (!isAdmin(request, env)) return error('管理令牌无效', 401);
  if (parts.length === 2 && request.method === 'GET') {
    const entries = [];
    let cursor;
    do {
      const result = await env.CONFIGS.list({ prefix: 'config:', cursor });
      entries.push(...result.keys.map(k => ({ id: k.name.slice(7), ...k.metadata })));
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    return json(entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }
  if (parts.length === 3 && request.method === 'GET') {
    const c = await readConfig(env, parts[2]);
    return c ? json(c) : error('配置不存在', 404);
  }
  if (parts.length === 3 && request.method === 'DELETE') {
    if (!validId(parts[2])) return error('ID 无效');
    await env.CONFIGS.delete(key(parts[2]));
    return json({ ok: true });
  }
  const creating = parts.length === 2 && request.method === 'POST';
  const editing = parts.length === 3 && request.method === 'PUT' && validId(parts[2]);
  if (!creating && !editing) return error('未找到接口', 404);
  const old = editing ? await readConfig(env, parts[2]) : null;
  if (editing && !old) return error('配置不存在', 404);
  const raw = await request.text();
  if (raw.length > 100_000) return error('输入过大', 413);
  const input = JSON.parse(raw);
  const bundledUrl = new URL(DEFAULT_SHADOWROCKET_CONF, request.url).toString();
  if (input.upstreamShadowrocketConf === bundledUrl) input.upstreamShadowrocketConf = DEFAULT_SHADOWROCKET_CONF;
  const data = validateConfig(input, new URL(request.url).hostname);
  const id = creating ? randomToken(12) : parts[2];
  const c = { ...data, id, token: old?.token || randomToken(24), createdAt: old?.createdAt || new Date().toISOString() };
  await env.CONFIGS.put(key(id), JSON.stringify(c), { metadata: { name: c.name, updatedAt: c.updatedAt } });
  return json(c, creating ? 201 : 200);
}

async function handleSubscription(request, env, parts) {
  if (request.method !== 'GET' || parts.length !== 4 || !validId(parts[1])) return error('未找到订阅', 404);
  const c = await readConfig(env, parts[1]);
  if (!c || c.token !== parts[2]) return error('未找到订阅', 404);
  const kind = parts[3];
  let body, mime, usage = '';
  if (kind === 'mihomo.yaml') {
    const upstream = await fetchUpstream(c.upstreamMihomo, 'clash.meta');
    body = generateMihomo(withRuntimeCf(c, env.ADMIN_SECRET), upstream.body);
    mime = 'text/yaml; charset=utf-8'; usage = upstream.usage;
  } else if (kind === 'shadowrocket.nodes') {
    const upstream = await fetchUpstream(c.upstreamMihomo, 'clash.meta');
    body = generateShadowrocketSubscription(withRuntimeCf(c, env.ADMIN_SECRET), upstream.body);
    mime = 'text/plain; charset=utf-8'; usage = upstream.usage;
  } else if (kind === 'shadowrocket.conf') {
    let original;
    if (!c.upstreamShadowrocketConf || c.upstreamShadowrocketConf === DEFAULT_SHADOWROCKET_CONF) {
      const asset = await env.ASSETS.fetch('https://assets.local/shadowrocket-default.conf');
      if (!asset.ok) throw new Error('内置 Shadowrocket default.conf 不可用');
      original = await asset.text();
    } else {
      original = (await fetchUpstream(c.upstreamShadowrocketConf, 'Shadowrocket')).body;
    }
    body = generateShadowrocketConf(c, request.url, original);
    mime = 'text/plain; charset=utf-8';
  } else return error('未找到订阅', 404);
  const headers = { 'content-type': mime, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' };
  if (usage) headers['subscription-userinfo'] = usage;
  return new Response(body, { headers });
}

export default {
  async fetch(request, env) {
    try {
      if (!UUID_PATTERN.test(env.ADMIN_SECRET || '')) return error('ADMIN_SECRET 必须是 UUID', 500);
      const pathname = new URL(request.url).pathname;
      const parts = pathname.split('/').filter(Boolean);
      if (pathname === WS_PATH) {
        if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          return new Response('WebSocket required', { status: 426 });
        return await handleVlessWebSocket(request, env.ADMIN_SECRET);
      }
      if (!env.CONFIGS) return error('缺少 KV 绑定 CONFIGS', 500);
      if (parts[0] === 'api' && parts[1] === 'configs') return await handleAdmin(request, env, parts);
      if (parts[0] === 's') return await handleSubscription(request, env, parts);
      return error('未找到页面', 404);
    } catch (e) {
      const message = e instanceof SyntaxError ? 'JSON 格式无效' : e.message || '服务异常';
      return error(message, /原订阅|fetch failed|timeout|网络/.test(message) ? 502 : 400);
    }
  }
};
