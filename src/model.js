import { parseProxyUri, builtinFirstHopUri } from './uri.js';

// Exact suffixes match the apex and its subdomains, never arbitrary occurrences
// such as gpt.haha.com. Keep the IP-check site out of UDP blocking.
export const AI_DOMAINS = [
  'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
  'oaistatsig.com', 'openaimerge.com',
  'claude.ai', 'claude.com', 'anthropic.com'
];
export const DEFAULT_DOMAINS = [
  ['DOMAIN-SUFFIX', 'ipinfo.io'],
  ...AI_DOMAINS.map(domain => ['DOMAIN-SUFFIX', domain])
];
// Mainland China direct rules placed just before MATCH / FINAL. Mihomo uses its
// built-in geo databases; Shadowrocket has GEOIP but no GEOSITE, so its domains
// come from blackmatrix7's maintained Shadowrocket rule set.
export const CN_DIRECT_MIHOMO = ['GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT'];
export const CN_DIRECT_SHADOWROCKET = [
  'RULE-SET,https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Shadowrocket/China/China.list,DIRECT',
  'GEOIP,CN,DIRECT'
];
export const DEFAULT_SHADOWROCKET_CONF = '/shadowrocket-default.conf';
export const WS_PATH = '/ws';
export const FIRST_HOP_GROUP = 'FIRST-HOP';
export const RESI_GROUP = 'RESI';
// 'upstream' keeps the original MATCH / FINAL; 'first-hop' is the group holding the first hop.
export const MATCH_TARGETS = ['upstream', 'DIRECT', 'RESI', 'first-hop'];
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateConfig(raw, currentHost = '', secret = '') {
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) throw new Error('请填写配置名称（最多 80 字）');
  const firstHop = validateFirstHop(raw.firstHop, currentHost, secret);
  const hopName = parseProxyUri(firstHop.url || builtinFirstHopUri(currentHost, secret, WS_PATH)).name;
  const residential = raw.residential;
  if (!Array.isArray(residential) || residential.length < 1 || residential.length > 30) throw new Error('请填写 1–30 个住宅代理');
  const seen = new Set([hopName, RESI_GROUP, FIRST_HOP_GROUP]);
  const rows = residential.map((p, i) => {
    const type = p.type ?? 'http';
    if (type !== 'http' && type !== 'socks5') throw new Error(`住宅节点 ${i+1} 类型无效`);
    const node = {
      name: String(p.name || '').trim(), type, server: String(p.server || '').trim(),
      port: Number(p.port), username: String(p.username || ''), password: String(p.password || ''),
      udp: type === 'socks5' && p.udp !== false
    };
    if (!node.name || /[,=\r\n]/.test(node.name) || seen.has(node.name)) throw new Error(`住宅节点 ${i+1} 名称无效或重复`);
    if (!/^[a-z0-9.:-]+$/i.test(node.server) || !node.server) throw new Error(`${node.name} 的地址无效`);
    if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) throw new Error(`${node.name} 的端口无效`);
    if (!node.username || !node.password || /[\r\n]/.test(node.username + node.password)) throw new Error(`${node.name} 的账号或密码无效`);
    seen.add(node.name);
    return node;
  });
  function upstream(s, label) {
    s = String(s || '').trim();
    if (!s) return '';
    let u;
    try { u = new URL(s); } catch { throw new Error(`${label} URL 无效`); }
    if (u.protocol !== 'https:') throw new Error(`${label} 必须使用 HTTPS`);
    return u.toString();
  }
  const upstreamMihomo = upstream(raw.upstreamMihomo, 'Mihomo 原订阅');
  let match = raw.match ?? 'upstream';
  if (!MATCH_TARGETS.includes(match)) throw new Error('兜底规则无效');
  // Without an original subscription there is no original MATCH to keep.
  if (match === 'upstream' && !upstreamMihomo) match = 'DIRECT';
  return {
    name, upstreamMihomo,
    upstreamShadowrocketConf: raw.upstreamShadowrocketConf === DEFAULT_SHADOWROCKET_CONF
      ? DEFAULT_SHADOWROCKET_CONF
      : (() => {
          const url = upstream(raw.upstreamShadowrocketConf, 'Shadowrocket 原 .conf');
          if (!url) throw new Error('请填写 Shadowrocket 原 .conf URL');
          return url;
        })(),
    firstHop, residential: rows, match,
    cnDirect: raw.cnDirect !== false,
    updatedAt: new Date().toISOString()
  };
}

// The built-in Worker relay is stored without its UUID (ADMIN_SECRET), which is
// filled in when a subscription is generated.
function validateFirstHop(input, currentHost, secret) {
  const url = String(input?.url || '').trim();
  if (!url) throw new Error('请填写第一跳节点链接');
  if (url.length > 4096) throw new Error('第一跳节点链接过长');
  const node = JSON.stringify(parseProxyUri(url));
  if (secret && node === JSON.stringify(parseProxyUri(builtinFirstHopUri(currentHost, secret, WS_PATH))))
    return { mode: 'builtin', domain: currentHost };
  return { mode: 'custom', url };
}

// Configs saved before the first hop became a share link carry `cf` instead.
export function normalizeConfig(c) {
  if (!c) return c;
  // Earlier versions named the residential group US-RESI and only had HTTP nodes.
  const match = c.match === 'US-RESI' ? RESI_GROUP : c.match ?? 'upstream';
  const cnDirect = c.cnDirect ?? true;
  const residential = c.residential.map(p => ({ type: 'http', udp: false, ...p }));
  if (c.firstHop) return { ...c, match, cnDirect, residential };
  const { cf, ...rest } = c;
  const firstHop = cf?.mode === 'external'
    ? { mode: 'custom', url: builtinFirstHopUri(cf.domain, cf.uuid, cf.wsPath) }
    : { mode: 'builtin', domain: cf?.domain };
  return { ...rest, match, cnDirect, residential, firstHop };
}

export function withRuntimeFirstHop(c, secret) {
  return c.firstHop.mode === 'builtin'
    ? { ...c, firstHop: { ...c.firstHop, url: builtinFirstHopUri(c.firstHop.domain, secret, WS_PATH) } }
    : c;
}

export function randomToken(bytes = 24) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}
