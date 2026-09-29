import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { validateConfig } from '../src/model.js';
import { generateMihomo, generateShadowrocketSubscription, generateShadowrocketConf } from '../src/generate.js';
import worker from '../src/worker.js';
import { parseVlessHeader, decodeEarlyData } from '../src/ws.js';

const secret = '12345678-1234-1234-1234-123456789abc';

const input = {
  name: '测试', upstreamMihomo: '', upstreamShadowrocketConf: '/shadowrocket-default.conf',
  cf: { domain: 'site.example.com' },
  residential: [{ name: '伊利诺伊', server: '38.213.131.218', port: 20000, username: 'user', password: 'pass' }],
  rejectUdp443: true
};
const savedConfig = validateConfig(input, 'site.example.com');
const c = { ...savedConfig, cf: { ...savedConfig.cf, uuid: secret, wsPath: '/ws' } };

test('Mihomo merges original nodes, groups, and rules without changing their order', () => {
  const original = YAML.stringify({ proxies: [{ name: 'old', type: 'socks5', server: 'old.example.com', port: 1080 }],
    'proxy-groups': [{ name: 'OLD', type: 'select', proxies: ['old'] }], rules: ['MATCH,OLD'], dns: { enable: true } });
  const result = YAML.parse(generateMihomo(c, original));
  assert.equal(result.proxies[0].name, 'cf-worker');
  assert.equal(result.proxies[1]['dialer-proxy'], 'cf-worker');
  assert.equal(result.proxies[2].name, 'old');
  assert.equal(result['proxy-groups'][1].name, 'OLD');
  assert.equal(result.rules.at(-1), 'MATCH,OLD');
  assert.equal(result.rules[0], 'AND,((DOMAIN-SUFFIX,openai.com),(NETWORK,UDP),(DST-PORT,443)),REJECT');
  assert.ok(result.rules.every(rule => !rule.includes('DOMAIN-KEYWORD')));
  assert.ok(result.rules.some(rule => rule === 'DOMAIN-SUFFIX,chatgpt.com,US-RESI'));
  assert.equal(result.dns.enable, true);
});

test('Mihomo rejects a colliding original node name', () => {
  assert.throws(() => generateMihomo(c, 'proxies:\n  - name: cf-worker\n    type: direct\n'), /重名/);
});

test('Mihomo adds a fallback only when the original rules are empty', () => {
  const withoutFallback = YAML.stringify({ proxies: [], rules: ['DOMAIN-SUFFIX,example.com,DIRECT'] });
  const merged = YAML.parse(generateMihomo(c, withoutFallback));
  assert.equal(merged.rules.at(-1), 'DOMAIN-SUFFIX,example.com,DIRECT');
  assert.equal(merged.rules.filter(rule => rule.startsWith('MATCH,')).length, 0);

  const noOriginalRules = YAML.stringify({ proxies: [], rules: [] });
  const fresh = YAML.parse(generateMihomo(c, noOriginalRules));
  assert.equal(fresh.rules.at(-1), 'MATCH,DIRECT');
});

test('Shadowrocket converts supported Mihomo nodes and uses the supplied default conf', () => {
  const old = YAML.stringify({
    proxies: [{ name: 'old', type: 'trojan', server: 'old.example.com', port: 443, password: 'secret' }],
    'proxy-providers': { remote: { type: 'http', url: 'https://example.com/provider.yaml' } },
    'proxy-groups': [{ name: 'OLD-GROUP', type: 'select', proxies: ['old'] }],
    rules: ['DOMAIN-SUFFIX,old.example.com,OLD-GROUP', 'MATCH,DIRECT']
  });
  const combined = Buffer.from(generateShadowrocketSubscription(c, old), 'base64').toString('utf8');
  assert.match(combined, /trojan:\/\/secret@old.example.com/);
  assert.match(combined, /vless:\/\/12345678/);
  assert.match(combined, /http:\/\/user:pass@38.213.131.218:20000/);
  assert.doesNotMatch(combined, /OLD-GROUP|MATCH,DIRECT|DOMAIN-SUFFIX/);
  const defaultConf = readFileSync(new URL('../public/shadowrocket-default.conf', import.meta.url), 'utf8');
  const conf = generateShadowrocketConf(c, 'https://example.com/rules.conf', defaultConf);
  assert.match(conf, /US-RESI = select, 伊利诺伊/);
  assert.match(conf, /DOMAIN-SUFFIX,openai.com,US-RESI/);
  assert.match(conf, /AND,\(\(DOMAIN-SUFFIX,chatgpt.com\),\(PROTOCOL,UDP\),\(DST-PORT,443\)\),REJECT-NO-DROP/);
  assert.match(conf, /IP-CIDR,17.0.0.0\/8,DIRECT/);
  assert.equal((conf.match(/^FINAL,PROXY$/gm) || []).length, 1);
  const merged = generateShadowrocketConf(c, 'https://example.com/new.conf', '[General]\nupdate-url = https://old.example.com/conf\n\n[Rule]\nDOMAIN-SUFFIX,old.example.com,DIRECT\nFINAL,PROXY\n');
  assert.match(merged, /DOMAIN-SUFFIX,old.example.com,DIRECT/);
  assert.match(merged, /update-url = https:\/\/example.com\/new.conf/);
  assert.doesNotMatch(merged, /old.example.com\/conf/);
});

test('Shadowrocket skips unsupported protocols and keeps supported nodes', () => {
  const upstream = YAML.stringify({ proxies: [
    { name: '🇭🇰 [HY2 Normal]', type: 'hysteria2', server: 'host.example.com', port: 443 },
    { name: 'old-socks', type: 'socks5', server: 'old.example.com', port: 1080 },
  ] });
  const links = Buffer.from(generateShadowrocketSubscription(c, upstream), 'base64').toString('utf8');
  assert.doesNotMatch(links, /HY2 Normal|hysteria2/);
  assert.match(links, /socks5:\/\/old.example.com:1080/);
  assert.match(links, /vless:\/\/12345678/);
  const onlyUnsupported = YAML.stringify({ proxies: [{ name: 'hy2', type: 'hysteria2', server: 'host.example.com', port: 443 }] });
  const fallback = Buffer.from(generateShadowrocketSubscription(c, onlyUnsupported), 'base64').toString('utf8');
  assert.match(fallback, /vless:\/\/12345678/);
  assert.doesNotMatch(fallback, /hy2/);
  assert.throws(() => generateShadowrocketSubscription(c, 'proxies:\n  - name: bad-ss\n    type: ss\n    server: example.com\n    port: 443'), /缺少 SS 加密方法或密码/);
});

test('Shadowrocket converts a basic Mihomo AnyTLS node with SNI', () => {
  const original = YAML.stringify({ proxies: [{
    name: '剩余流量：109.46 GB', type: 'anytls', server: '43.229.154.252', port: 666,
    password: 'test-secret', udp: true, sni: 'speedtest.example.com'
  }] });
  const links = Buffer.from(generateShadowrocketSubscription(c, original), 'base64').toString('utf8').trim().split('\n');
  const uri = new URL(links[0]);
  assert.equal(uri.protocol, 'anytls:');
  assert.equal(uri.username, 'test-secret');
  assert.equal(uri.hostname, '43.229.154.252');
  assert.equal(uri.port, '666');
  assert.equal(uri.searchParams.get('sni'), 'speedtest.example.com');
  assert.equal(decodeURIComponent(uri.hash.slice(1)), '剩余流量：109.46 GB');
  const advanced = YAML.stringify({ proxies: [{ name: 'advanced', type: 'anytls', server: 'example.com',
    port: 443, password: 'test', alpn: ['h2'] }] });
  assert.throws(() => generateShadowrocketSubscription(c, advanced), /AnyTLS alpn 暂无法可靠转换/);
});

test('Worker stores one JSON object per group and serves tokenized URLs', async () => {
  const map = new Map();
  const env = { ADMIN_SECRET: secret, CONFIGS: {
    get: async k => map.has(k) ? JSON.parse(map.get(k)) : null,
    put: async (k, v) => map.set(k, v),
    delete: async k => map.delete(k),
    list: async () => ({ keys: [...map.keys()].map(name => ({ name, metadata: { name: '测试' } })), list_complete: true })
  }, ASSETS: { fetch: async () => new Response(readFileSync(new URL('../public/shadowrocket-default.conf', import.meta.url), 'utf8')) } };
  const create = await worker.fetch(new Request('https://site.example.com/api/configs', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ ...input, upstreamShadowrocketConf: 'https://site.example.com/shadowrocket-default.conf' })
  }), env);
  assert.equal(create.status, 201);
  const saved = await create.json();
  assert.equal(map.size, 1);
  assert.equal(saved.upstreamShadowrocketConf, '/shadowrocket-default.conf');
  assert.equal(saved.cf.mode, 'builtin');
  assert.equal(saved.cf.uuid, undefined);
  const url = `https://site.example.com/s/${saved.id}/${saved.token}/mihomo.yaml`;
  const result = await worker.fetch(new Request(url), env);
  assert.equal(result.status, 200);
  assert.equal(YAML.parse(await result.text()).proxies[1]['dialer-proxy'], 'cf-worker');
  assert.equal(YAML.parse(await (await worker.fetch(new Request(url), env)).text()).proxies[0].uuid, secret);
  const shadowConf = await worker.fetch(new Request(url.replace('mihomo.yaml', 'shadowrocket.conf')), env);
  assert.equal(shadowConf.status, 200);
  assert.match(await shadowConf.text(), /IP-CIDR,17.0.0.0\/8,DIRECT/);
  const shadowNodes = await worker.fetch(new Request(url.replace('mihomo.yaml', 'shadowrocket.nodes')), env);
  assert.match(Buffer.from(await shadowNodes.text(), 'base64').toString('utf8'), /vless:\/\/12345678-1234-1234-1234-123456789abc@site.example.com:443/);
  const denied = await worker.fetch(new Request(url.replace(saved.token, 'wrong')), env);
  assert.equal(denied.status, 404);
  const wrongPlace = await worker.fetch(new Request('https://site.example.com/api/configs', {
    method: 'POST', body: JSON.stringify({ ...input, ADMIN_SECRET: secret })
  }), env);
  assert.equal(wrongPlace.status, 401);
});

test('external CF domain requires its own UUID and path and uses both in subscriptions', async () => {
  const external = { ...input, cf: { domain: 'relay.example.net', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', wsPath: '/relay' } };
  assert.throws(() => validateConfig({ ...external, cf: { domain: 'relay.example.net' } }, 'site.example.com'), /UUID 无效/);
  assert.throws(() => validateConfig({ ...external, cf: { ...external.cf, wsPath: '' } }, 'site.example.com'), /路径无效/);
  const stored = new Map();
  const env = { ADMIN_SECRET: secret, CONFIGS: {
    get: async key => JSON.parse(stored.get(key)),
    put: async (key, value) => stored.set(key, value)
  } };
  const response = await worker.fetch(new Request('https://site.example.com/api/configs', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(external)
  }), env);
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.cf.mode, 'external');
  const root = `https://site.example.com/s/${saved.id}/${saved.token}`;
  const mihomo = YAML.parse(await (await worker.fetch(new Request(`${root}/mihomo.yaml`), env)).text());
  assert.equal(mihomo.proxies[0].uuid, external.cf.uuid);
  assert.equal(mihomo.proxies[0]['ws-opts'].path, '/relay');
  const nodes = Buffer.from(await (await worker.fetch(new Request(`${root}/shadowrocket.nodes`), env)).text(), 'base64').toString('utf8');
  assert.match(nodes, /vless:\/\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@relay.example.net:443/);
  assert.match(nodes, /path=%2Frelay/);
});

test('VLESS header waits for all bytes, checks UUID and accepts TCP only', () => {
  const host = new TextEncoder().encode('example.com');
  const head = Uint8Array.from([
    0, ...Buffer.from(secret.replaceAll('-', ''), 'hex'), 0,
    1, 1, 187, 2, host.length, ...host, 0xaa
  ]);
  assert.equal(parseVlessHeader(head.subarray(0, 24), secret).state, 'incomplete');
  const parsed = parseVlessHeader(head, secret);
  assert.equal(parsed.state, 'ok');
  assert.equal(parsed.hostname, 'example.com');
  assert.equal(parsed.port, 443);
  assert.deepEqual([...parsed.payload], [0xaa]);
  assert.equal(parseVlessHeader(head, '00000000-0000-0000-0000-000000000000').state, 'invalid');
  const udp = head.slice(); udp[18] = 2;
  assert.equal(parseVlessHeader(udp, secret).state, 'invalid');
  assert.deepEqual([...decodeEarlyData('AAEC')], [0, 1, 2]);
});

test('only WebSocket upgrades are accepted on /ws', async () => {
  const env = { ADMIN_SECRET: secret };
  const response = await worker.fetch(new Request('https://example.com/ws'), env);
  assert.equal(response.status, 426);
  const invalid = await worker.fetch(new Request('https://example.com/ws'), { ADMIN_SECRET: 'not-a-uuid' });
  assert.equal(invalid.status, 500);
});

test('Shadowrocket conf URL is required for new groups', () => {
  assert.throws(() => validateConfig({ ...input, upstreamShadowrocketConf: '' }, 'site.example.com'), /请填写 Shadowrocket 原 .conf URL/);
});

test('subscription request fetches a fresh upstream configuration', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 1;
  globalThis.fetch = async () => new Response(`proxies:\n  - name: old-${revision}\n    type: socks5\n    server: old.example.com\n    port: 1080\nrules:\n  - MATCH,DIRECT\n`);
  try {
    const withUpstream = validateConfig({ ...input, upstreamMihomo: 'https://upstream.example.com/sub' }, 'site.example.com');
    const env = { ADMIN_SECRET: secret, CONFIGS: { get: async () => ({ ...withUpstream, token: 'secret' }) } };
    const url = 'https://example.com/s/123456789012345678901234/secret/mihomo.yaml';
    const first = YAML.parse(await (await worker.fetch(new Request(url), env)).text());
    revision = 2;
    const second = YAML.parse(await (await worker.fetch(new Request(url), env)).text());
    assert.equal(first.proxies.at(-1).name, 'old-1');
    assert.equal(second.proxies.at(-1).name, 'old-2');
  } finally { globalThis.fetch = originalFetch; }
});
