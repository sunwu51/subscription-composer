import YAML from 'yaml';
import { AI_DOMAINS, DEFAULT_DOMAINS, FIRST_HOP_GROUP, RESI_GROUP, CN_DIRECT_MIHOMO, CN_DIRECT_SHADOWROCKET } from './model.js';
import { parseProxyUri, namedProxyUri } from './uri.js';
import { mihomoNodesToShadowrocketLinks } from './convert.js';

// The built-in Worker relay only forwards TCP.
function firstHopNode(c) {
  const node = parseProxyUri(c.firstHop.url);
  return c.firstHop.mode === 'builtin' ? { ...node, udp: false } : node;
}

// QUIC to the AI domains is rejected unless every hop can carry UDP: the first
// hop and each residential node (SOCKS5 with UDP). A stalled QUIC attempt makes
// apps wait before falling back to TCP; REJECT makes them fall back at once.
function rejectsUdp443(c) {
  return !(firstHopNode(c).udp && c.residential.every(p => p.type === 'socks5' && p.udp));
}

const matchRule = rule => /^\s*MATCH\s*,/i.test(String(rule));
const finalRule = line => /^\s*FINAL\s*,/i.test(line);

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
  const hop = firstHopNode(c);
  const oldGroupList = base['proxy-groups'] || [];
  if (oldGroupList.length && !oldGroupList[0]?.name) throw new Error('原配置的第一个分组缺少名称');
  const oldNames = new Set((base.proxies || []).map(p => p?.name));
  const oldGroups = new Set(oldGroupList.map(p => p?.name));
  const newNames = [hop.name, ...c.residential.map(p => p.name)];
  for (const name of newNames) if (oldNames.has(name) || oldGroups.has(name)) throw new Error(`原配置与新节点重名：${name}`);
  if (oldGroups.has(RESI_GROUP) || oldNames.has(RESI_GROUP)) throw new Error(`原配置已有 ${RESI_GROUP} 名称`);
  // A dedicated group makes the fallback really use the first hop; the original
  // first group keeps its own selection.
  const ownGroup = !oldGroupList.length || c.match === 'first-hop';
  if (ownGroup && (oldNames.has(FIRST_HOP_GROUP) || oldGroups.has(FIRST_HOP_GROUP)))
    throw new Error(`原配置已有 ${FIRST_HOP_GROUP} 名称`);
  const residential = c.residential.map(p => ({
    name: p.name, type: p.type, server: p.server, port: p.port,
    username: p.username, password: p.password, ...(p.type === 'socks5' ? { udp: p.udp } : {}),
    'dialer-proxy': hop.name
  }));
  // A custom first hop goes second in every original group, so each group can
  // pick it while its default (first) choice stays. The built-in relay is only
  // appended to the first group.
  const custom = c.firstHop.mode !== 'builtin';
  const withHop = (group, index) => {
    if (!custom && index > 0) return group;
    const proxies = [...(group.proxies || [])];
    if (custom) proxies.splice(1, 0, hop.name);
    else proxies.push(hop.name);
    return { ...group, proxies };
  };
  const hopGroups = [
    ...(ownGroup ? [{ name: FIRST_HOP_GROUP, type: 'select', proxies: [hop.name] }] : []),
    ...oldGroupList.map(withHop)
  ];
  const target = { DIRECT: 'DIRECT', RESI: RESI_GROUP, 'first-hop': FIRST_HOP_GROUP }[c.match];
  const prefix = [
    ...(rejectsUdp443(c) ? AI_DOMAINS.map(domain => `AND,((DOMAIN-SUFFIX,${domain}),(NETWORK,UDP),(DST-PORT,443)),REJECT`) : []),
    ...DEFAULT_DOMAINS.map(([kind, value]) => `${kind},${value},${RESI_GROUP}`)
  ];
  const oldRules = base.rules || [];
  const cn = c.cnDirect ? CN_DIRECT_MIHOMO : [];
  const matchAt = oldRules.findIndex(matchRule);
  const result = {
    ...base,
    ...(!upstream ? { 'mixed-port': 7890 } : {}),
    mode: 'rule',
    proxies: [hop, ...residential, ...(base.proxies || [])],
    'proxy-groups': [{ name: RESI_GROUP, type: 'select', proxies: residential.map(p => p.name) }, ...hopGroups],
    rules: target
      ? [...prefix, ...oldRules.filter(rule => !matchRule(rule)), ...cn, `MATCH,${target}`]
      : matchAt >= 0
        ? [...prefix, ...oldRules.slice(0, matchAt), ...cn, ...oldRules.slice(matchAt)]
        : [...prefix, ...oldRules, ...cn, ...(oldRules.length ? [] : ['MATCH,DIRECT'])]
  };
  return YAML.stringify(result, { lineWidth: 0 });
}

function b64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function newShadowrocketLinks(c) {
  const links = [namedProxyUri(c.firstHop.url, firstHopNode(c).name)];
  for (const p of c.residential) {
    const uri = new URL(`${p.type}://${p.server}:${p.port}`);
    uri.username = p.username;
    uri.password = p.password;
    uri.hash = encodeURIComponent(p.name);
    links.push(uri.toString());
  }
  return links;
}

export function generateShadowrocketSubscription(c, upstream = '') {
  const reserved = [firstHopNode(c).name, RESI_GROUP, FIRST_HOP_GROUP, ...c.residential.map(p => p.name)];
  const old = mihomoNodesToShadowrocketLinks(upstream, reserved);
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
  const hasGroup = name => groups.lines.some(line => line.split('=')[0].trim().toUpperCase() === name);
  if (hasGroup(RESI_GROUP)) throw new Error(`原 Shadowrocket .conf 已有 ${RESI_GROUP} 分组`);
  if (c.match === 'first-hop') {
    if (hasGroup(FIRST_HOP_GROUP))
      throw new Error(`原 Shadowrocket .conf 已有 ${FIRST_HOP_GROUP} 分组`);
    groups.lines.unshift(`${FIRST_HOP_GROUP} = select, ${firstHopNode(c).name}`);
  }
  groups.lines.unshift(`${RESI_GROUP} = select, ${c.residential.map(p => p.name).join(', ')}`);
  const rules = section('Rule');
  const oldRules = rules.lines.filter(line => line.trim() && !line.trim().startsWith('#'));
  rules.lines.unshift(
    ...(rejectsUdp443(c) ? AI_DOMAINS.map(domain => `AND,((DOMAIN-SUFFIX,${domain}),(PROTOCOL,UDP),(DST-PORT,443)),REJECT-NO-DROP`) : []),
    ...DEFAULT_DOMAINS.map(([kind, value]) => `${kind},${value},${RESI_GROUP}`)
  );
  const target = { DIRECT: 'DIRECT', RESI: RESI_GROUP, 'first-hop': FIRST_HOP_GROUP }[c.match];
  const cn = c.cnDirect ? CN_DIRECT_SHADOWROCKET : [];
  if (target) rules.lines = rules.lines.filter(line => !finalRule(line));
  const finalAt = rules.lines.findIndex(finalRule);
  if (finalAt >= 0) rules.lines.splice(finalAt, 0, ...cn);
  else {
    while (rules.lines.length && !rules.lines.at(-1).trim()) rules.lines.pop();
    rules.lines.push(...cn, ...(target ? [`FINAL,${target}`] : oldRules.length ? [] : ['FINAL,PROXY']));
  }
  return sections.map(s => `[${s.name}]\n${s.lines.join('\n').trim()}\n`).join('\n');
}
