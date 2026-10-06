import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { validateConfig, normalizeConfig } from '../src/model.js';
import { parseProxyUri } from '../src/uri.js';
import { generateMihomo, generateShadowrocketSubscription, generateShadowrocketConf } from '../src/generate.js';
import worker from '../src/worker.js';

const secret = '12345678-1234-1234-1234-123456789abc';
const hopUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const hopUrl = `vless://${hopUuid}@vps.example.net:443?encryption=none&security=tls&type=ws&host=vps.example.net&path=%2Fp#vps`;

const input = {
  name: '测试', upstreamMihomo: '', upstreamShadowrocketConf: '/shadowrocket-default.conf',
  firstHop: { url: hopUrl },
  residential: [{ name: '伊利诺伊', server: '38.213.131.218', port: 20000, username: 'user', password: 'pass' }],
  rejectUdp443: true
};
const savedConfig = validateConfig(input);
// Keep the original MATCH and skip CN rules so the merge tests below exercise the untouched rules.
const c = { ...savedConfig, match: 'upstream', cnDirect: false };

test('Mihomo merges original nodes, groups, and rules without changing their order', () => {
  const original = YAML.stringify({ proxies: [{ name: 'old', type: 'socks5', server: 'old.example.com', port: 1080 }],
    'proxy-groups': [{ name: 'OLD', type: 'select', proxies: ['old'] }], rules: ['MATCH,OLD'], dns: { enable: true } });
  const result = YAML.parse(generateMihomo(c, original));
  assert.equal(result.proxies[0].name, 'vps');
  assert.equal(result.proxies[1]['dialer-proxy'], 'vps');
  assert.equal(result.proxies[2].name, 'old');
  assert.equal(result['proxy-groups'][1].name, 'OLD');
  assert.equal(result.rules.at(-1), 'MATCH,OLD');
  assert.equal(result.rules[0], 'AND,((DOMAIN-SUFFIX,openai.com),(NETWORK,UDP),(DST-PORT,443)),REJECT');
  assert.ok(result.rules.every(rule => !rule.includes('DOMAIN-KEYWORD')));
  assert.ok(result.rules.some(rule => rule === 'DOMAIN-SUFFIX,chatgpt.com,RESI'));
  assert.equal(result.dns.enable, true);
});

test('Mihomo rejects a colliding original node name', () => {
  assert.throws(() => generateMihomo(c, 'proxies:\n  - name: vps\n    type: direct\n'), /重名/);
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

test('Mihomo adds redir-host DNS only without an original subscription', () => {
  const standalone = YAML.parse(generateMihomo(c));
  assert.equal(standalone.dns['enhanced-mode'], 'redir-host');
  assert.equal(standalone.dns['fake-ip-range'], undefined);
  assert.deepEqual(standalone.dns.nameserver, ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query']);
  const merged = YAML.parse(generateMihomo(c, YAML.stringify({ proxies: [], rules: [] })));
  assert.equal(merged.dns, undefined);
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
  assert.match(combined, /vless:\/\/aaaaaaaa/);
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
  assert.match(links, /vless:\/\/aaaaaaaa/);
  const onlyUnsupported = YAML.stringify({ proxies: [{ name: 'hy2', type: 'hysteria2', server: 'host.example.com', port: 443 }] });
  const fallback = Buffer.from(generateShadowrocketSubscription(c, onlyUnsupported), 'base64').toString('utf8');
  assert.match(fallback, /vless:\/\/aaaaaaaa/);
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
  assert.deepEqual(saved.firstHop, { url: hopUrl });
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
  const url = `https://site.example.com/s/${saved.id}/${saved.token}/mihomo.yaml`;
  const result = await worker.fetch(new Request(url), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('profile-update-interval'), '24');
  assert.equal(YAML.parse(await result.text()).proxies[1]['dialer-proxy'], 'vps');
  assert.equal(YAML.parse(await (await worker.fetch(new Request(url), env)).text()).proxies[0].uuid, hopUuid);
  const shadowConf = await worker.fetch(new Request(url.replace('mihomo.yaml', 'shadowrocket.conf')), env);
  assert.equal(shadowConf.status, 200);
  assert.match(await shadowConf.text(), /IP-CIDR,17.0.0.0\/8,DIRECT/);
  const shadowNodes = await worker.fetch(new Request(url.replace('mihomo.yaml', 'shadowrocket.nodes')), env);
  assert.match(Buffer.from(await shadowNodes.text(), 'base64').toString('utf8'), /vless:\/\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@vps.example.net:443/);
  const denied = await worker.fetch(new Request(url.replace(saved.token, 'wrong')), env);
  assert.equal(denied.status, 404);
  const wrongPlace = await worker.fetch(new Request('https://site.example.com/api/configs', {
    method: 'POST', body: JSON.stringify({ ...input, ADMIN_SECRET: secret })
  }), env);
  assert.equal(wrongPlace.status, 401);
});

test('a custom first hop link is stored as-is and used by both clients', async () => {
  const hy2 = 'hysteria2://pass@203.0.113.6:36097?alpn=h3&insecure=1&pinSHA256=AB:CD&down=100#my-hy2';
  assert.throws(() => validateConfig({ ...input, firstHop: { url: 'https://example.com' } }), /地址或端口/);
  assert.throws(() => validateConfig({ ...input, firstHop: { url: 'wireguard://x@h:1' } }), /暂不支持/);
  assert.throws(() => validateConfig({ ...input, firstHop: { url: hy2 },
    residential: [{ ...input.residential[0], name: 'my-hy2' }] }), /名称无效或重复/);
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
  assert.deepEqual(saved.firstHop, { url: hy2 });
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
    cf: { domain: 'relay.example.net', mode: 'external', uuid: hopUuid, wsPath: '/relay' } });
  assert.equal(external.match, 'upstream');
  assert.equal(external.cf, undefined);
  const node = parseProxyUri(external.firstHop.url);
  assert.equal(node.name, 'cf-worker');
  assert.equal(node.uuid, hopUuid);
  assert.equal(node['ws-opts'].path, '/relay');
  assert.deepEqual(normalizeConfig({ ...savedConfig, firstHop: { mode: 'custom', url: hopUrl } }).firstHop, { url: hopUrl });
});

test('configs that used the removed built-in relay must set a new first hop', async () => {
  const legacy = normalizeConfig({ ...savedConfig, firstHop: undefined, cf: { domain: 'site.example.com', mode: 'builtin' } });
  assert.deepEqual(legacy.firstHop, { url: '' });
  const stored = { ...savedConfig, firstHop: { mode: 'builtin', domain: 'site.example.com' }, token: 'secret' };
  assert.deepEqual(normalizeConfig(stored).firstHop, { url: '' });
  const env = { ADMIN_SECRET: secret, CONFIGS: { get: async () => stored } };
  const response = await worker.fetch(new Request('https://example.com/s/123456789012345678901234/secret/mihomo.yaml'), env);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /第一跳节点未设置/);
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

test('the first hop joins the original groups, or gets a group of its own', () => {
  const original = YAML.stringify({ proxies: [{ name: 'old', type: 'socks5', server: 'old.example.com', port: 1080 }],
    'proxy-groups': [{ name: 'PICK', type: 'select', proxies: ['old'] }, { name: 'AUTO', type: 'url-test', proxies: ['old'] }],
    rules: ['DOMAIN-SUFFIX,a.com,AUTO', 'MATCH,PICK'] });
  const merged = YAML.parse(generateMihomo({ ...c, match: 'upstream' }, original));
  assert.deepEqual(merged['proxy-groups'].map(g => g.name), ['RESI', 'PICK', 'AUTO']);
  assert.deepEqual(merged['proxy-groups'][1].proxies, ['old', 'vps']);
  assert.deepEqual(merged['proxy-groups'][2].proxies, ['old', 'vps']);
  assert.equal(merged.rules.at(-1), 'MATCH,PICK');
  const fresh = YAML.parse(generateMihomo({ ...c, match: 'first-hop' }));
  assert.deepEqual(fresh['proxy-groups'][1], { name: 'FIRST-HOP', type: 'select', proxies: ['vps'] });
  assert.equal(fresh.rules.at(-1), 'MATCH,FIRST-HOP');
});

test('MATCH and FINAL follow the chosen fallback', () => {
  const original = YAML.stringify({ proxies: [], 'proxy-groups': [{ name: 'PICK', type: 'select', proxies: ['DIRECT'] }],
    rules: ['DOMAIN-SUFFIX,a.com,DIRECT', 'MATCH,PICK'] });
  const withHop = YAML.parse(generateMihomo({ ...c, match: 'first-hop' }, original))['proxy-groups'];
  assert.deepEqual(withHop.map(g => g.name), ['RESI', 'FIRST-HOP', 'PICK']);
  assert.deepEqual(withHop[1].proxies, ['vps']);
  assert.deepEqual(withHop[2].proxies, ['DIRECT', 'vps']);
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
  assert.match(hop, /FIRST-HOP = select, vps/);
  assert.deepEqual(finals(hop), ['FINAL,FIRST-HOP']);
  assert.equal(validateConfig({ ...input, match: 'upstream' }).match, 'DIRECT');
  assert.throws(() => validateConfig({ ...input, match: 'PROXY' }), /兜底规则无效/);
});

test('the removed relay path is not served and ADMIN_SECRET must be a UUID', async () => {
  const env = { ADMIN_SECRET: secret, CONFIGS: {} };
  const upgrade = { headers: { upgrade: 'websocket' } };
  assert.equal((await worker.fetch(new Request('https://example.com/ws', upgrade), env)).status, 404);
  const invalid = await worker.fetch(new Request('https://example.com/api/configs'), { ADMIN_SECRET: 'not-a-uuid' });
  assert.equal(invalid.status, 500);
});

test('Shadowrocket conf URL is required for new groups', () => {
  assert.throws(() => validateConfig({ ...input, upstreamShadowrocketConf: '' }), /请填写 Shadowrocket 原 .conf URL/);
});

test('subscription request fetches a fresh upstream configuration', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 1;
  globalThis.fetch = async () => new Response(`proxies:\n  - name: old-${revision}\n    type: socks5\n    server: old.example.com\n    port: 1080\nrules:\n  - MATCH,DIRECT\n`);
  try {
    const withUpstream = validateConfig({ ...input, upstreamMihomo: 'https://upstream.example.com/sub' });
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
  assert.equal(validateConfig({ ...input, cnDirect: false }).cnDirect, false);
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
  const build = (url, residential) => validateConfig({ ...input, firstHop: { url }, residential });
  const rejects = config => YAML.parse(generateMihomo(config)).rules.some(rule => rule.includes('(DST-PORT,443)),REJECT'));
  const open = build(hy2, [socks]);
  assert.equal(open.residential[0].udp, true);
  assert.equal(rejects(open), false);
  assert.doesNotMatch(generateShadowrocketConf(open, '', ''), /REJECT-NO-DROP/);
  assert.equal(rejects(build(hy2, [{ ...socks, udp: false }])), true);
  assert.equal(rejects(build(hy2, [socks, { ...input.residential[0] }])), true);
  assert.equal(rejects(build(hopUrl, [socks])), false);
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
  const custom = validateConfig({ ...input, firstHop: { url: 'hysteria2://pass@203.0.113.6:36097#hy2' } });
  const original = YAML.stringify({ proxies: [{ name: 'old', type: 'socks5', server: 'old.example.com', port: 1080 }],
    'proxy-groups': [{ name: 'PICK', type: 'select', proxies: ['AUTO', 'DIRECT', 'old'] },
      { name: 'AUTO', type: 'url-test', proxies: ['old'] }, { name: 'DIRECT-GROUP', type: 'select', proxies: ['DIRECT', 'PICK'] },
      { name: 'PROVIDER', type: 'select', use: ['remote'] }],
    rules: ['MATCH,PICK'] });
  const groups = YAML.parse(generateMihomo({ ...custom, match: 'upstream' }, original))['proxy-groups'];
  assert.deepEqual(groups.map(g => g.proxies), [['伊利诺伊'],['AUTO', 'hy2', 'DIRECT', 'old'], ['old', 'hy2'],
    ['DIRECT', 'hy2', 'PICK'], ['hy2']]);
});
