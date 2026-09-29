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
export const DEFAULT_SHADOWROCKET_CONF = '/shadowrocket-default.conf';
export const WS_PATH = '/ws';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateConfig(raw, currentHost = '') {
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) throw new Error('请填写配置名称（最多 80 字）');
  const cf = raw.cf || {};
  const domain = String(cf.domain || '').trim();
  const sameHost = domain.toLowerCase().replace(/\.$/, '') === currentHost.toLowerCase().replace(/\.$/, '');
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain) || (!domain.includes('.') && !sameHost))
    throw new Error('CF 域名无效');
  let cfConfig = { domain, mode: 'builtin' };
  if (!sameHost) {
    const uuid = String(cf.uuid || '').trim();
    const wsPath = String(cf.wsPath || '').trim();
    if (!UUID_PATTERN.test(uuid)) throw new Error('外部 CF 中转 UUID 无效');
    if (!wsPath.startsWith('/') || wsPath.length > 1024 || /[\r\n#]/.test(wsPath))
      throw new Error('外部 CF 中转 WebSocket 路径无效');
    cfConfig = { domain, mode: 'external', uuid, wsPath };
  }
  const residential = raw.residential;
  if (!Array.isArray(residential) || residential.length < 1 || residential.length > 30) throw new Error('请填写 1–30 个住宅代理');
  const seen = new Set(['cf-worker', 'US-RESI']);
  const rows = residential.map((p, i) => {
    const node = {
      name: String(p.name || '').trim(), server: String(p.server || '').trim(),
      port: Number(p.port), username: String(p.username || ''), password: String(p.password || '')
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
  return {
    name, upstreamMihomo: upstream(raw.upstreamMihomo, 'Mihomo 原订阅'),
    upstreamShadowrocketConf: raw.upstreamShadowrocketConf === DEFAULT_SHADOWROCKET_CONF
      ? DEFAULT_SHADOWROCKET_CONF
      : (() => {
          const url = upstream(raw.upstreamShadowrocketConf, 'Shadowrocket 原 .conf');
          if (!url) throw new Error('请填写 Shadowrocket 原 .conf URL');
          return url;
        })(),
    cf: cfConfig, residential: rows,
    rejectUdp443: Boolean(raw.rejectUdp443),
    updatedAt: new Date().toISOString()
  };
}

export function randomToken(bytes = 24) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}
