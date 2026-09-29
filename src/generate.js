import YAML from 'yaml';
import { AI_DOMAINS, DEFAULT_DOMAINS } from './model.js';
import { mihomoNodesToShadowrocketLinks } from './convert.js';

function workerNode(c) {
  return {
    name: 'cf-worker', type: 'vless', server: c.cf.domain, port: 443,
    uuid: c.cf.uuid, udp: false, tls: true, servername: c.cf.domain,
    'client-fingerprint': 'chrome', network: 'ws',
    'ws-opts': { path: c.cf.wsPath, headers: { Host: c.cf.domain } }
  };
}

export function generateMihomo(c, upstream = '') {
  let base = {};
  if (upstream) {
    try { base = YAML.parse(upstream); } catch { throw new Error('Mihomo 原订阅不是有效 YAML'); }
    if (!base || typeof base !== 'object' || Array.isArray(base) ||
        (!Array.isArray(base.proxies) && !base['proxy-providers']))
      throw new Error('Mihomo 原订阅不是完整的 Mihomo 配置');
  }
  for (const key of ['proxies', 'proxy-groups', 'rules']) {
    if (base[key] != null && !Array.isArray(base[key])) throw new Error(`原配置的 ${key} 不是列表`);
  }
  const oldNames = new Set((base.proxies || []).map(p => p?.name));
  const oldGroups = new Set((base['proxy-groups'] || []).map(p => p?.name));
  const newNames = ['cf-worker', ...c.residential.map(p => p.name)];
  for (const name of newNames) if (oldNames.has(name) || oldGroups.has(name)) throw new Error(`原配置与新节点重名：${name}`);
  if (oldGroups.has('US-RESI') || oldNames.has('US-RESI')) throw new Error('原配置已有 US-RESI 名称');
  const residential = c.residential.map(p => ({
    name: p.name, type: 'http', server: p.server, port: p.port,
    username: p.username, password: p.password, 'dialer-proxy': 'cf-worker'
  }));
  const prefix = [
    ...(c.rejectUdp443 ? AI_DOMAINS.map(domain => `AND,((DOMAIN-SUFFIX,${domain}),(NETWORK,UDP),(DST-PORT,443)),REJECT`) : []),
    ...DEFAULT_DOMAINS.map(([kind, value]) => `${kind},${value},US-RESI`)
  ];
  const oldRules = base.rules || [];
  const result = {
    ...base,
    ...(!upstream ? { 'mixed-port': 7890 } : {}),
    mode: 'rule',
    proxies: [workerNode(c), ...residential, ...(base.proxies || [])],
    'proxy-groups': [{ name: 'US-RESI', type: 'select', proxies: residential.map(p => p.name) }, ...(base['proxy-groups'] || [])],
    rules: [...prefix, ...oldRules, ...(oldRules.length ? [] : ['MATCH,DIRECT'])]
  };
  return YAML.stringify(result, { lineWidth: 0 });
}

function b64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function newShadowrocketLinks(c) {
  const vless = new URL(`vless://${c.cf.uuid}@${c.cf.domain}:443`);
  vless.searchParams.set('encryption', 'none');
  vless.searchParams.set('security', 'tls');
  vless.searchParams.set('type', 'ws');
  vless.searchParams.set('sni', c.cf.domain);
  vless.searchParams.set('host', c.cf.domain);
  vless.searchParams.set('path', c.cf.wsPath);
  vless.hash = encodeURIComponent('cf-worker');
  const links = [vless.toString()];
  for (const p of c.residential) {
    const uri = new URL(`http://${p.server}:${p.port}`);
    uri.username = p.username;
    uri.password = p.password;
    uri.hash = encodeURIComponent(p.name);
    links.push(uri.toString());
  }
  return links;
}

export function generateShadowrocketSubscription(c, upstream = '') {
  const old = mihomoNodesToShadowrocketLinks(upstream, ['cf-worker', 'US-RESI', ...c.residential.map(p => p.name)]);
  return b64(new TextEncoder().encode([...old, ...newShadowrocketLinks(c)].join('\n') + '\n'));
}

export function generateShadowrocketConf(c, selfUrl = '', upstream = '') {
  const sections = [];
  if (upstream.trim()) {
    for (const line of upstream.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.trim().match(/^\[([^\]]+)\]$/);
      if (match) sections.push({ name: match[1], lines: [] });
      else if (sections.length) sections.at(-1).lines.push(line);
      else if (line.trim() && !line.trim().startsWith('#')) throw new Error('Shadowrocket 原 .conf 格式无效');
    }
    if (!sections.length) throw new Error('Shadowrocket 原 .conf 缺少配置段');
  }
  function section(name) {
    let found = sections.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!found) { found = { name, lines: [] }; sections.push(found); }
    return found;
  }
  const general = section('General');
  general.lines = general.lines.filter(line => !/^\s*update-url\s*=/i.test(line));
  if (selfUrl) general.lines.unshift(`update-url = ${selfUrl}`);
  const groups = section('Proxy Group');
  const groupIndex = sections.indexOf(groups);
  const ruleIndex = sections.findIndex(s => s.name.toLowerCase() === 'rule');
  if (ruleIndex >= 0 && groupIndex > ruleIndex) {
    sections.splice(groupIndex, 1);
    sections.splice(ruleIndex, 0, groups);
  }
  if (groups.lines.some(line => /^\s*US-RESI\s*=/i.test(line))) throw new Error('原 Shadowrocket .conf 已有 US-RESI 分组');
  groups.lines.unshift(`US-RESI = select, ${c.residential.map(p => p.name).join(', ')}`);
  const rules = section('Rule');
  const oldRules = rules.lines.filter(line => line.trim() && !line.trim().startsWith('#'));
  rules.lines.unshift(
    ...(c.rejectUdp443 ? AI_DOMAINS.map(domain => `AND,((DOMAIN-SUFFIX,${domain}),(PROTOCOL,UDP),(DST-PORT,443)),REJECT-NO-DROP`) : []),
    ...DEFAULT_DOMAINS.map(([kind, value]) => `${kind},${value},US-RESI`)
  );
  if (!oldRules.length) rules.lines.push('FINAL,PROXY');
  return sections.map(s => `[${s.name}]\n${s.lines.join('\n').trim()}\n`).join('\n');
}
