// Parse a share URI (the sing-box / v2rayN style used by 233boy scripts,
// Shadowrocket and most panels) into a Mihomo proxy object.
const TRANSPORTS = new Set(['tcp', 'ws', 'grpc', 'h2', 'http', 'httpupgrade']);

function fromBase64(text) {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function toBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function endpoint(u, label) {
  const server = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 缺少有效的地址或端口`);
  return { server, port };
}

const flag = value => ['1', 'true'].includes(String(value).toLowerCase());
const list = value => value ? String(value).split(',').map(s => s.trim()).filter(Boolean) : undefined;
const clean = node => Object.fromEntries(Object.entries(node).filter(([, v]) => v != null && v !== ''));

// Transport and TLS options shared by VLESS, Trojan and VMess.
function transport(node, o, label) {
  const network = String(o.network || 'tcp').toLowerCase();
  if (!TRANSPORTS.has(network)) throw new Error(`${label} 的传输类型 ${network} 暂不支持`);
  if (network === 'ws' || network === 'httpupgrade') {
    node.network = 'ws';
    node['ws-opts'] = clean({ path: o.path || '/', headers: o.host ? { Host: o.host } : undefined,
      'v2ray-http-upgrade': network === 'httpupgrade' || undefined });
  } else if (network === 'grpc') {
    node.network = 'grpc';
    node['grpc-opts'] = { 'grpc-service-name': o.serviceName || o.path || '' };
  } else if (network === 'h2' || network === 'http') {
    node.network = 'h2';
    node['h2-opts'] = clean({ host: list(o.host), path: o.path || '/' });
  } else if (o.headerType && o.headerType !== 'none') {
    throw new Error(`${label} 的 TCP 伪装类型 ${o.headerType} 暂不支持`);
  }
  if (o.security === 'reality') {
    if (!o.pbk) throw new Error(`${label} 的 Reality 缺少 pbk`);
    node['reality-opts'] = clean({ 'public-key': o.pbk, 'short-id': o.sid });
  }
  return node;
}

function streamOptions(params) {
  return {
    network: params.get('type'), host: params.get('host'), path: params.get('path'),
    serviceName: params.get('serviceName'), headerType: params.get('headerType'),
    security: (params.get('security') || '').toLowerCase(), pbk: params.get('pbk'), sid: params.get('sid')
  };
}

function tlsCommon(params) {
  return clean({
    alpn: list(params.get('alpn')),
    'client-fingerprint': params.get('fp') || undefined,
    'skip-cert-verify': flag(params.get('allowInsecure')) || flag(params.get('insecure')) || undefined
  });
}

function parseVmess(raw) {
  let data;
  try { data = JSON.parse(fromBase64(raw.slice('vmess://'.length).split('#')[0])); }
  catch { throw new Error('VMess 链接不是有效的 Base64 JSON'); }
  const port = Number(data.port);
  if (!data.add || !Number.isInteger(port) || !data.id) throw new Error('VMess 链接缺少地址、端口或 UUID');
  const tls = data.tls === 'tls';
  const node = {
    name: String(data.ps || '').trim(), type: 'vmess', server: data.add, port, uuid: data.id,
    alterId: Number(data.aid || 0), cipher: data.scy || 'auto', udp: true,
    ...(tls ? { tls: true, servername: data.sni || data.host || undefined } : {}),
    ...(tls ? clean({ alpn: list(data.alpn), 'client-fingerprint': data.fp || undefined }) : {})
  };
  return clean(transport(clean(node), { network: data.net, host: data.host, path: data.path,
    serviceName: data.path, headerType: data.net === 'tcp' ? data.type : 'none' }, 'VMess 链接'));
}

function parseShadowsocks(raw) {
  let body = raw.slice('ss://'.length);
  const hashIndex = body.indexOf('#');
  const hash = hashIndex >= 0 ? body.slice(hashIndex) : '';
  if (hashIndex >= 0) body = body.slice(0, hashIndex);
  // Legacy form: ss://BASE64(method:password@host:port)
  if (!body.includes('@')) {
    try { body = fromBase64(body.split('?')[0]); } catch { throw new Error('SS 链接格式无效'); }
  }
  const u = new URL(`ss://${body}${hash}`);
  if (u.searchParams.get('plugin')) throw new Error('SS 插件暂不支持作为第一跳');
  let userinfo = decodeURIComponent(u.username) + (u.password ? `:${decodeURIComponent(u.password)}` : '');
  if (!userinfo.includes(':')) {
    try { userinfo = fromBase64(userinfo); } catch { throw new Error('SS 链接的加密方法和密码无效'); }
  }
  const split = userinfo.indexOf(':');
  if (split < 1) throw new Error('SS 链接缺少加密方法或密码');
  return { name: decodeURIComponent(u.hash.slice(1)).trim(), type: 'ss', ...endpoint(u, 'SS 链接'), cipher: userinfo.slice(0, split),
    password: userinfo.slice(split + 1), udp: true };
}

export function parseProxyUri(input) {
  const raw = String(input || '').trim();
  const scheme = raw.match(/^([a-z0-9+.-]+):\/\//i)?.[1].toLowerCase();
  if (!scheme) throw new Error('第一跳节点必须是形如 vless:// 的分享链接');
  if (/[\s]/.test(raw)) throw new Error('第一跳节点链接不能包含空白字符');
  let node;
  if (scheme === 'vmess') node = parseVmess(raw);
  else if (scheme === 'ss') node = parseShadowsocks(raw);
  else {
    let u;
    try { u = new URL(raw); } catch { throw new Error('第一跳节点链接无效'); }
    const p = u.searchParams;
    const user = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    const label = `${scheme} 链接`;
    const base = { name: '', ...endpoint(u, label) };
    if (scheme === 'vless' || scheme === 'trojan') {
      if (!user) throw new Error(`${label} 缺少${scheme === 'vless' ? ' UUID' : '密码'}`);
      const o = streamOptions(p);
      const security = o.security || (scheme === 'trojan' ? 'tls' : 'none');
      const tls = security === 'tls' || security === 'reality';
      node = scheme === 'vless'
        ? { ...base, type: 'vless', uuid: user, udp: true, flow: p.get('flow') || undefined,
            ...(tls ? { tls: true, servername: p.get('sni') || undefined, ...tlsCommon(p) } : {}) }
        : { ...base, type: 'trojan', password: user, udp: true,
            sni: p.get('sni') || undefined, ...tlsCommon(p) };
      node = transport(clean(node), { ...o, security }, label);
    } else if (scheme === 'hysteria2' || scheme === 'hy2') {
      if (!user) throw new Error(`${label} 缺少密码`);
      const pin = (p.get('pinSHA256') || '').replace(/:/g, '').toLowerCase();
      node = clean({ ...base, type: 'hysteria2', password: password ? `${user}:${password}` : user,
        ports: p.get('mport') || undefined, sni: p.get('sni') || undefined,
        'skip-cert-verify': flag(p.get('insecure')) || undefined, alpn: list(p.get('alpn')),
        fingerprint: pin || undefined, obfs: p.get('obfs') || undefined,
        'obfs-password': p.get('obfs-password') || undefined,
        up: p.get('up') || p.get('upmbps') || undefined, down: p.get('down') || p.get('downmbps') || undefined,
        udp: true });
    } else if (scheme === 'tuic') {
      if (!user || !password) throw new Error(`${label} 缺少 UUID 或密码`);
      node = clean({ ...base, type: 'tuic', uuid: user, password, sni: p.get('sni') || undefined,
        alpn: list(p.get('alpn')), 'congestion-controller': p.get('congestion_control') || undefined,
        'udp-relay-mode': p.get('udp_relay_mode') || undefined,
        'skip-cert-verify': flag(p.get('allow_insecure')) || flag(p.get('insecure')) || undefined, udp: true });
    } else if (scheme === 'anytls') {
      if (!user) throw new Error(`${label} 缺少密码`);
      node = clean({ ...base, type: 'anytls', password: user, sni: p.get('sni') || undefined,
        ...tlsCommon(p), udp: true });
    } else if (['socks', 'socks5', 'http', 'https'].includes(scheme)) {
      const http = scheme.startsWith('http');
      node = clean({ ...base, type: http ? 'http' : 'socks5', username: user || undefined,
        password: password || undefined, tls: scheme === 'https' || undefined, udp: http ? undefined : true });
    } else {
      throw new Error(`第一跳节点暂不支持 ${scheme}:// 链接`);
    }
    node.name = decodeURIComponent(u.hash.slice(1)).trim();
  }
  const { name, ...rest } = node;
  if (/[,=\r\n]/.test(name || '') || (name || '').length > 80) throw new Error('第一跳节点名称（# 后的部分）不能包含逗号、等号或换行');
  return { name: name || 'first-hop', ...rest };
}

// The same link with its display name pinned to the name Mihomo uses, so
// Shadowrocket shows a node that the residential chain can reference.
export function namedProxyUri(input, name) {
  const raw = String(input).trim();
  if (/^vmess:\/\//i.test(raw)) {
    const data = JSON.parse(fromBase64(raw.slice('vmess://'.length).split('#')[0]));
    return `vmess://${toBase64(JSON.stringify({ ...data, ps: name }))}`;
  }
  return `${raw.split('#')[0]}#${encodeURIComponent(name)}`;
}
