import YAML from 'yaml';

const SUPPORTED_TYPES = new Set(['http', 'socks5', 'socks', 'ss', 'anytls', 'vmess', 'vless', 'trojan']);

function b64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function host(server) {
  const s = String(server || '');
  return s.includes(':') && !s.startsWith('[') ? `[${s}]` : s;
}

function link(kind, node, user = '', password = '') {
  const uri = new URL(`${kind}://${host(node.server)}:${node.port}`);
  if (user) uri.username = user;
  if (password) uri.password = password;
  uri.hash = encodeURIComponent(node.name);
  return uri;
}

function convertNode(p) {
  if (!p?.name || !p.server || !p.port || !p.type) throw new Error('Mihomo 原订阅有字段不完整的节点');
  const type = String(p.type).toLowerCase();
  if (type === 'http' || type === 'socks5' || type === 'socks') {
    const scheme = type === 'http' && p.tls ? 'https' : type === 'http' ? 'http' : 'socks5';
    return link(scheme, p, p.username, p.password).toString();
  }
  if (type === 'ss') {
    if (p.plugin || p['plugin-opts']) throw new Error(`节点「${p.name}」使用 SS 插件，暂无法可靠转换到 Shadowrocket`);
    if (!p.cipher || !p.password) throw new Error(`节点「${p.name}」缺少 SS 加密方法或密码`);
    return `ss://${b64(`${p.cipher}:${p.password}`)}@${host(p.server)}:${p.port}#${encodeURIComponent(p.name)}`;
  }
  if (type === 'anytls') {
    if (!p.password) throw new Error(`节点「${p.name}」缺少 AnyTLS 密码`);
    const unsupported = ['shadow-tls-opts', 'restls-opts', 'jls-opts', 'reality-opts', 'ech-opts',
      'alpn', 'client-fingerprint', 'fingerprint', 'name-cert-verify'];
    const option = unsupported.find(key => p[key] != null);
    if (option) throw new Error(`节点「${p.name}」的 AnyTLS ${option} 暂无法可靠转换到 Shadowrocket URI`);
    const uri = link('anytls', p, p.password);
    uri.pathname = '/';
    if (p.sni || p.servername) uri.searchParams.set('sni', p.sni || p.servername);
    if (p['skip-cert-verify']) uri.searchParams.set('insecure', '1');
    return uri.toString();
  }
  if (type === 'vmess') {
    if (!p.uuid) throw new Error(`节点「${p.name}」缺少 VMess UUID`);
    if (p.network && !['tcp', 'ws'].includes(p.network)) throw new Error(`节点「${p.name}」的 VMess 传输类型暂不支持转换`);
    const ws = p['ws-opts'] || {};
    const data = {
      v: '2', ps: p.name, add: p.server, port: String(p.port), id: p.uuid,
      aid: String(p.alterId ?? 0), scy: p.cipher || 'auto', net: p.network || 'tcp',
      type: 'none', host: ws.headers?.Host || ws.headers?.host || '',
      path: ws.path || '', tls: p.tls ? 'tls' : '', sni: p.servername || ''
    };
    return `vmess://${b64(JSON.stringify(data))}`;
  }
  if (type === 'vless' || type === 'trojan') {
    const credential = type === 'vless' ? p.uuid : p.password;
    if (!credential) throw new Error(`节点「${p.name}」缺少凭据`);
    if (p.network && !['tcp', 'ws'].includes(p.network)) throw new Error(`节点「${p.name}」的传输类型暂不支持转换`);
    if (p['reality-opts']) throw new Error(`节点「${p.name}」使用 Reality，暂无法可靠转换到 Shadowrocket`);
    const uri = link(type, p, credential);
    if (type === 'vless') uri.searchParams.set('encryption', 'none');
    uri.searchParams.set('security', type === 'trojan' || p.tls ? 'tls' : 'none');
    if (p.servername || p.sni) uri.searchParams.set('sni', p.servername || p.sni);
    if (p.network === 'ws') {
      const ws = p['ws-opts'] || {};
      uri.searchParams.set('type', 'ws');
      if (ws.path) uri.searchParams.set('path', ws.path);
      if (ws.headers?.Host || ws.headers?.host) uri.searchParams.set('host', ws.headers.Host || ws.headers.host);
    }
    if (p['client-fingerprint']) uri.searchParams.set('fp', p['client-fingerprint']);
    return uri.toString();
  }
  throw new Error(`节点「${p.name}」使用 ${p.type}，暂无法可靠转换到 Shadowrocket`);
}

export function mihomoNodesToShadowrocketLinks(yaml, reservedNames = []) {
  if (!yaml.trim()) return [];
  let data;
  try { data = YAML.parse(yaml); } catch { throw new Error('Mihomo 原订阅不是有效 YAML'); }
  if (!data || !Array.isArray(data.proxies)) throw new Error('Mihomo 原订阅没有内联 proxies 节点；proxy-providers 中的节点无法提取');
  const names = new Set(reservedNames);
  return data.proxies.flatMap(p => {
    if (!p?.type) throw new Error('Mihomo 原订阅有字段不完整的节点');
    if (!SUPPORTED_TYPES.has(String(p.type).toLowerCase())) return [];
    if (names.has(p?.name)) throw new Error(`原订阅节点名称与新节点重复：${p.name}`);
    names.add(p?.name);
    return [convertNode(p)];
  });
}
