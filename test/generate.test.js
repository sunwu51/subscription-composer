import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { validateConfig, normalizeConfig, withRuntimeFirstHop } from '../src/model.js';
import { parseProxyUri, builtinFirstHopUri } from '../src/uri.js';
import { generateMihomo, generateShadowrocketSubscription, generateShadowrocketConf } from '../src/generate.js';
import worker from '../src/worker.js';
import { parseVlessHeader, decodeEarlyData } from '../src/ws.js';

const secret = '12345678-1234-1234-1234-123456789abc';

const input = {
  name: '测试', upstreamMihomo: '', upstreamShadowrocketConf: '/shadowrocket-default.conf',
  firstHop: { url: builtinFirstHopUri('site.example.com', secret, '/ws') },
  residential: [{ name: '伊利诺伊', server: '38.213.131.218', port: 20000, username: 'user', password: 'pass' }],
  rejectUdp443: true
};
const savedConfig = validateConfig(input, 'site.example.com', secret);
// Keep the original MATCH and skip CN rules so the merge tests below exercise the untouched rules.
const c = { ...withRuntimeFirstHop(savedConfig, secret), match: 'upstream', cnDirect: false };

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
  assert.ok(result.rules.some(rule => rule === 'DOMAIN-SUFFIX,chatgpt.com,RESI'));
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
  assert.match(conf, /RESI = select, 伊利诺伊/);
  assert.match(conf, /DOMAIN-SUFFIX,openai.com,RESI/);
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
  assert.deepEqual(saved.firstHop, { mode: 'builtin', domain: 'site.example.com' });
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
  const url = `https://site.example.com/s/${saved.id}/${saved.token}/mihomo.yaml`;
  const result = await worker.fetch(new Request(url), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('profile-update-interval'), '24');
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

test('a custom first hop link is stored as-is and used by both clients', async () => {
  const hy2 = 'hysteria2://pass@203.0.113.6:36097?alpn=h3&insecure=1&pinSHA256=AB:CD&down=100#my-hy2';
  assert.throws(() => validateConfig({ ...input, firstHop: { url: 'https://example.com' } }, 'site.example.com', secret), /地址或端口/);
  assert.throws(() => validateConfig({ ...input, firstHop: { url: 'wireguard://x@h:1' } }, 'site.example.com', secret), /暂不支持/);
  assert.throws(() => validateConfig({ ...input, firstHop: { url: hy2 },
    residential: [{ ...input.residential[0], name: 'my-hy2' }] }, 'site.example.com', secret), /名称无效或重复/);
  const stored = new Map();
  const env = { ADMIN_SECRET: secret, CONFIGS: {
    get: async key => JSON.parse(stored.get(key)),
    put: async (key, value) => stored.set(key, value)
  } };
  const response = await worker.fetch(new Request('https://site.example.com/api/configs', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ ...input, firstHop: { url: hy2 } })
  }), env);
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.deepEqual(saved.firstHop, { mode: 'custom', url: hy2 });
  const root = `https://site.example.com/s/${saved.id}/${saved.token}`;
  const mihomo = YAML.parse(await (await worker.fetch(new Request(`${root}/mihomo.yaml`), env)).text());
  assert.deepEqual(mihomo.proxies[0], { name: 'my-hy2', server: '203.0.113.6', port: 36097, type: 'hysteria2',
    password: 'pass', 'skip-cert-verify': true, alpn: ['h3'], fingerprint: 'abcd', down: '100', udp: true });
  assert.equal(mihomo.proxies[1]['dialer-proxy'], 'my-hy2');
  const nodes = Buffer.from(await (await worker.fetch(new Request(`${root}/shadowrocket.nodes`), env)).text(), 'base64').toString('utf8');
  assert.match(nodes, /^hysteria2:\/\/pass@203\.0\.113\.6:36097\?alpn=h3.*#my-hy2$/m);
});

test('legacy configs keep working after the first hop became a link', () => {
  const external = normalizeConfig({ ...savedConfig, firstHop: undefined, match: undefined,
    cf: { domain: 'relay.example.net', mode: 'external', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', wsPath: '/relay' } });
  assert.equal(external.match, 'upstream');
  const node = parseProxyUri(external.firstHop.url);
  assert.equal(node.name, 'cf-worker');
  assert.equal(node.uuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(node['ws-opts'].path, '/relay');
  const builtin = normalizeConfig({ ...savedConfig, firstHop: undefined, cf: { domain: 'site.example.com', mode: 'builtin' } });
  assert.equal(parseProxyUri(withRuntimeFirstHop(builtin, secret).firstHop.url).uuid, secret);
});

test('share links of common protocols become Mihomo nodes', () => {
  const reality = parseProxyUri('vless://11111111-2222-3333-4444-555555555555@203.0.113.5:44554?encryption=none&security=reality&flow=xtls-rprx-vision&type=tcp&sni=aws.amazon.com&pbk=KEY&fp=chrome#233boy-reality');
  assert.equal(reality.flow, 'xtls-rprx-vision');
  assert.equal(reality.servername, 'aws.amazon.com');
  assert.deepEqual(reality['reality-opts'], { 'public-key': 'KEY' });
  assert.equal(reality.network, undefined);
  const ws = parseProxyUri('vless://66666666-7777-8888-9999-000000000000@v.example.org:443?encryption=none&security=tls&type=ws&host=v.example.org&path=/p#ws');
  assert.deepEqual(ws['ws-opts'], { path: '/p', headers: { Host: 'v.example.org' } });
  assert.equal(ws.tls, true);
  const vmess = parseProxyUri(`vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'vm', add: 'h.example.com', port: '443', id: 'u', aid: '0', net: 'ws', path: '/v', host: 'h.example.com', tls: 'tls' })).toString('base64')}`);
  assert.equal(vmess.name, 'vm');
  assert.equal(vmess['ws-opts'].path, '/v');
  const ss = parseProxyUri(`ss://${Buffer.from('aes-256-gcm:pw').toString('base64')}@1.2.3.4:8388#ss`);
  assert.deepEqual([ss.cipher, ss.password, ss.port, ss.name], ['aes-256-gcm', 'pw', 8388, 'ss']);
  const legacy = parseProxyUri(`ss://${Buffer.from('aes-128-gcm:pw@1.2.3.4:1234').toString('base64')}#old`);
  assert.deepEqual([legacy.server, legacy.port, legacy.name], ['1.2.3.4', 1234, 'old']);
  assert.equal(parseProxyUri('tuic://u:p@1.2.3.4:443?congestion_control=bbr').type, 'tuic');
  assert.equal(parseProxyUri('socks5://1.2.3.4:1080').name, 'first-hop');
});

test('the first hop joins the original first group, or gets a group of its own', () => {
  const original = YAML.stringify({ proxies: [{ name: 'old', type: 'socks5', server: 'old.example.com', port: 1080 }],
    'proxy-groups': [{ name: 'PICK', type: 'select', proxies: ['old'] }, { name: 'AUTO', type: 'url-test', proxies: ['old'] }],
    rules: ['DOMAIN-SUFFIX,a.com,AUTO', 'MATCH,PICK'] });
  const merged = YAML.parse(generateMihomo({ ...c, match: 'upstream' }, original));
  assert.deepEqual(merged['proxy-groups'].map(g => g.name), ['RESI', 'PICK', 'AUTO']);
  assert.deepEqual(merged['proxy-groups'][1].proxies, ['old', 'cf-worker']);
  assert.deepEqual(merged['proxy-groups'][2].proxies, ['old']);
  assert.equal(merged.rules.at(-1), 'MATCH,PICK');
  const fresh = YAML.parse(generateMihomo({ ...c, match: 'first-hop' }));
  assert.deepEqual(fresh['proxy-groups'][1], { name: 'FIRST-HOP', type: 'select', proxies: ['cf-worker'] });
  assert.equal(fresh.rules.at(-1), 'MATCH,FIRST-HOP');
});

test('MATCH and FINAL follow the chosen fallback', () => {
  const original = YAML.stringify({ proxies: [], 'proxy-groups': [{ name: 'PICK', type: 'select', proxies: ['DIRECT'] }],
    rules: ['DOMAIN-SUFFIX,a.com,DIRECT', 'MATCH,PICK'] });
  const withHop = YAML.parse(generateMihomo({ ...c, match: 'first-hop' }, original))['proxy-groups'];
  assert.deepEqual(withHop.map(g => g.name), ['RESI', 'FIRST-HOP', 'PICK']);
  assert.deepEqual(withHop[1].proxies, ['cf-worker']);
  assert.deepEqual(withHop[2].proxies, ['DIRECT', 'cf-worker']);
  for (const [match, target] of [['DIRECT', 'DIRECT'], ['RESI', 'RESI'], ['first-hop', 'FIRST-HOP']]) {
    const rules = YAML.parse(generateMihomo({ ...c, match }, original)).rules;
    assert.equal(rules.at(-1), `MATCH,${target}`);
    assert.equal(rules.filter(rule => rule.startsWith('MATCH,')).length, 1);
    assert.ok(rules.includes('DOMAIN-SUFFIX,a.com,DIRECT'));
  }
  const conf = '[Rule]\nDOMAIN-SUFFIX,a.com,DIRECT\nFINAL,PROXY\n';
  const finals = text => text.match(/^FINAL,.*$/gm);
  assert.deepEqual(finals(generateShadowrocketConf({ ...c, match: 'upstream' }, '', conf)), ['FINAL,PROXY']);
  assert.match(generateShadowrocketConf({ ...c, match: 'DIRECT' }, '', conf), /DOMAIN-SUFFIX,a\.com,DIRECT\nFINAL,DIRECT\n/);
  const hop = generateShadowrocketConf({ ...c, match: 'first-hop' }, '', conf);
  assert.match(hop, /FIRST-HOP = select, cf-worker/);
  assert.deepEqual(finals(hop), ['FINAL,FIRST-HOP']);
  assert.equal(validateConfig({ ...input, match: 'upstream' }, 'site.example.com', secret).match, 'DIRECT');
  assert.throws(() => validateConfig({ ...input, match: 'PROXY' }, 'site.example.com', secret), /兜底规则无效/);
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
  assert.throws(() => validateConfig({ ...input, upstreamShadowrocketConf: '' }, 'site.example.com', secret), /请填写 Shadowrocket 原 .conf URL/);
});

test('subscription request fetches a fresh upstream configuration', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 1;
  globalThis.fetch = async () => new Response(`proxies:\n  - name: old-${revision}\n    type: socks5\n    server: old.example.com\n    port: 1080\nrules:\n  - MATCH,DIRECT\n`);
  try {
    const withUpstream = validateConfig({ ...input, upstreamMihomo: 'https://upstream.example.com/sub' }, 'site.example.com', secret);
    const env = { ADMIN_SECRET: secret, CONFIGS: { get: async () => ({ ...withUpstream, token: 'secret' }) } };
    const url = 'https://example.com/s/123456789012345678901234/secret/mihomo.yaml';
    const first = YAML.parse(await (await worker.fetch(new Request(url), env)).text());
    revision = 2;
    const second = YAML.parse(await (await worker.fetch(new Request(url), env)).text());
    assert.equal(first.proxies.at(-1).name, 'old-1');
    assert.equal(second.proxies.at(-1).name, 'old-2');
  } finally { globalThis.fetch = originalFetch; }
});

test('CN direct rules sit right before the fallback when enabled', () => {
  assert.equal(savedConfig.cnDirect, true);
  assert.equal(validateConfig({ ...input, cnDirect: false }, 'site.example.com', secret).cnDirect, false);
  const cn = { ...c, cnDirect: true };
  const original = YAML.stringify({ proxies: [], 'proxy-groups': [{ name: 'PICK', type: 'select', proxies: ['DIRECT'] }],
    rules: ['DOMAIN-SUFFIX,a.com,DIRECT', 'MATCH,PICK'] });
  assert.deepEqual(YAML.parse(generateMihomo(cn, original)).rules.slice(-4),
    ['DOMAIN-SUFFIX,a.com,DIRECT', 'GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,PICK']);
  assert.deepEqual(YAML.parse(generateMihomo({ ...cn, match: 'first-hop' }, original)).rules.slice(-3),
    ['GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,FIRST-HOP']);
  assert.deepEqual(YAML.parse(generateMihomo(cn)).rules.slice(-3), ['GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,DIRECT']);
  const rules = conf => conf.split('[Rule]\n')[1].split('\n\n')[0].trim().split('\n').slice(-3);
  const conf = '[Rule]\nDOMAIN-SUFFIX,a.com,DIRECT\nFINAL,PROXY\n';
  assert.deepEqual(rules(generateShadowrocketConf(cn, '', conf)).slice(1), ['GEOIP,CN,DIRECT', 'FINAL,PROXY']);
  assert.match(rules(generateShadowrocketConf(cn, '', conf))[0], /^RULE-SET,https:\/\/.*China\.list,DIRECT$/);
  assert.deepEqual(rules(generateShadowrocketConf({ ...cn, match: 'RESI' }, '', conf)).slice(1), ['GEOIP,CN,DIRECT', 'FINAL,RESI']);
  assert.equal(normalizeConfig({ ...savedConfig, cnDirect: undefined }).cnDirect, true);
});

test('UDP 443 is rejected unless the first hop and every residential node carry UDP', () => {
  const hy2 = 'hysteria2://pass@203.0.113.6:36097#hy2';
  const socks = { name: 'socks-a', type: 'socks5', server: '1.2.3.4', port: 1080, username: 'u', password: 'p' };
  const build = (url, residential) => withRuntimeFirstHop(validateConfig({ ...input, firstHop: { url }, residential }, 'site.example.com', secret), secret);
  const rejects = config => YAML.parse(generateMihomo(config)).rules.some(rule => rule.includes('(DST-PORT,443)),REJECT'));
  const open = build(hy2, [socks]);
  assert.equal(open.residential[0].udp, true);
  assert.equal(rejects(open), false);
  assert.doesNotMatch(generateShadowrocketConf(open, '', ''), /REJECT-NO-DROP/);
  assert.equal(rejects(build(hy2, [{ ...socks, udp: false }])), true);
  assert.equal(rejects(build(hy2, [socks, { ...input.residential[0] }])), true);
  assert.equal(rejects(build(input.firstHop.url, [socks])), true);
  assert.equal(rejects(build('http://1.2.3.4:8080#h', [socks])), true);
  const node = YAML.parse(generateMihomo(open)).proxies[1];
  assert.deepEqual([node.type, node.udp, node['dialer-proxy']], ['socks5', true, 'hy2']);
  assert.equal(YAML.parse(generateMihomo(c)).proxies[1].udp, undefined);
  const links = Buffer.from(generateShadowrocketSubscription(open), 'base64').toString('utf8');
  assert.match(links, /^socks5:\/\/u:p@1\.2\.3\.4:1080#socks-a$/m);
  assert.throws(() => build(hy2, [{ ...socks, type: 'https' }]), /类型无效/);
});

test('legacy residential rows and the US-RESI fallback are migrated', () => {
  const legacy = normalizeConfig({ ...savedConfig, match: 'US-RESI',
    residential: [{ name: 'old', server: '1.2.3.4', port: 80, username: 'u', password: 'p' }] });
  assert.equal(legacy.match, 'RESI');
  assert.deepEqual([legacy.residential[0].type, legacy.residential[0].udp], ['http', false]);
});

test('a custom first hop goes second in every original group', () => {
  const custom = withRuntimeFirstHop(validateConfig({ ...input, firstHop: { url: 'hysteria2://pass@203.0.113.6:36097#hy2' } },
    'site.example.com', secret), secret);
  const original = YAML.stringify({ proxies: [{ name: 'old', type: 'socks5', server: 'old.example.com', port: 1080 }],
    'proxy-groups': [{ name: 'PICK', type: 'select', proxies: ['AUTO', 'DIRECT', 'old'] },
      { name: 'AUTO', type: 'url-test', proxies: ['old'] }, { name: 'DIRECT-GROUP', type: 'select', proxies: ['DIRECT', 'PICK'] },
      { name: 'PROVIDER', type: 'select', use: ['remote'] }],
    rules: ['MATCH,PICK'] });
  const groups = YAML.parse(generateMihomo({ ...custom, match: 'upstream' }, original))['proxy-groups'];
  assert.deepEqual(groups.map(g => g.proxies), [['伊利诺伊'],['AUTO', 'hy2', 'DIRECT', 'old'], ['old', 'hy2'],
    ['DIRECT', 'hy2', 'PICK'], ['hy2']]);
});
