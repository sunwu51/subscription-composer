const $ = s => document.querySelector(s);
const form = $('#form');
const defaultConfUrl = new URL('/shadowrocket-default.conf', location.origin).toString();
form.elements.upstreamShadowrocketConf.defaultValue = defaultConfUrl;
let current = null;
let matchTouched = false;
let adminToken = sessionStorage.getItem('adminToken') || '';
$('#admin').value = adminToken;

// Mirrors builtinFirstHopUri in src/uri.js; the server recognises it and
// stores the built-in relay without the UUID.
function builtinHop(domain = location.hostname) {
  const u = new URL(`vless://${adminToken}@${domain}:443`);
  for (const [k, v] of Object.entries({ encryption: 'none', security: 'tls', type: 'ws', sni: domain, host: domain, path: '/ws', fp: 'chrome' }))
    u.searchParams.set(k, v);
  u.hash = 'cf-worker';
  return u.toString();
}
function hopName(link) {
  link = link.trim();
  try {
    if (/^vmess:\/\//i.test(link)) return JSON.parse(atob(link.slice(8).split('#')[0])).ps?.trim() || 'first-hop';
  } catch { return 'first-hop'; }
  const hash = link.includes('#') ? link.slice(link.indexOf('#') + 1) : '';
  try { return decodeURIComponent(hash).trim() || 'first-hop'; } catch { return hash || 'first-hop'; }
}
function syncHopName() {
  const name = hopName(form.elements.firstHop.value);
  document.querySelectorAll('.hop-name').forEach(el => { el.textContent = name; });
}
// Keeping the original MATCH needs an original subscription; default to it when there is one.
function syncMatch() {
  const hasUpstream = Boolean(form.elements.upstreamMihomo.value.trim());
  const select = form.elements.match;
  select.querySelector('option[value="upstream"]').disabled = !hasUpstream;
  if (!matchTouched) select.value = hasUpstream ? 'upstream' : 'DIRECT';
  else if (!hasUpstream && select.value === 'upstream') select.value = 'DIRECT';
}
form.elements.firstHop.addEventListener('input', syncHopName);
form.elements.upstreamMihomo.addEventListener('input', syncMatch);
form.elements.match.addEventListener('change', () => { matchTouched = true; });
$('#builtin-hop').onclick = () => { form.elements.firstHop.value = builtinHop(); syncHopName(); };

function setAuthenticated(connected) {
  $('#auth-card').hidden = connected;
  $('#app-header').hidden = !connected;
  $('#workspace').hidden = !connected;
  $('main').classList.toggle('locked', !connected);
  if (!connected) sessionStorage.removeItem('adminToken');
}

function status(message) {
  const el = $('#status'); el.textContent = message; el.classList.add('show');
  clearTimeout(status.timer); status.timer = setTimeout(() => el.classList.remove('show'), 5000);
}
async function api(path, options = {}) {
  const r = await fetch(path, { ...options, headers: { authorization: `Bearer ${adminToken}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401) setAuthenticated(false);
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return data;
}
function row(data = {}) {
  const box = document.createElement('div'); box.className = 'proxy';
  box.innerHTML = '<div class="proxy-head"><h4>住宅节点</h4><button type="button" class="danger remove">移除</button></div><div class="grid"><label>名称<input data-key="name" required placeholder="伊利诺伊"></label><label>类型<select data-key="type"><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select></label><label class="udp-field">支持 UDP<select data-key="udp"><option value="true">是</option><option value="false">否</option></select></label><label>服务器<input data-key="server" required placeholder="38.213.131.218"></label><label>端口<input data-key="port" type="number" min="1" max="65535" required placeholder="20000"></label><label>用户名<input data-key="username" required></label><label>密码<input data-key="password" type="password" required></label></div>';
  for (const [k, v] of Object.entries(data)) { const el = box.querySelector(`[data-key="${k}"]`); if (el) el.value = String(v); }
  // SOCKS5 nodes default to UDP support; HTTP proxies never carry UDP.
  const type = box.querySelector('[data-key="type"]');
  const syncUdp = () => { box.querySelector('.udp-field').hidden = type.value !== 'socks5'; };
  type.onchange = () => { box.querySelector('[data-key="udp"]').value = 'true'; syncUdp(); };
  syncUdp();
  box.querySelector('.remove').onclick = () => { if ($('#proxies').children.length > 1) box.remove(); else status('至少保留一个住宅节点'); };
  $('#proxies').append(box);
}
function reset() {
  current = null; form.reset(); $('#proxies').replaceChildren(); row();
  form.elements.firstHop.value = builtinHop(); syncHopName();
  matchTouched = false; syncMatch();
  $('#form-title').textContent = '新建配置组'; $('#delete').hidden = true; $('#results').hidden = true; $('#saved-at').textContent = '';
  document.querySelectorAll('#list button').forEach(x => x.classList.remove('active'));
}
function fill(c) {
  current = c; form.elements.name.value = c.name;
  form.elements.upstreamMihomo.value = c.upstreamMihomo;
  form.elements.upstreamShadowrocketConf.value = !c.upstreamShadowrocketConf || c.upstreamShadowrocketConf === '/shadowrocket-default.conf'
    ? defaultConfUrl : c.upstreamShadowrocketConf;
  form.elements.firstHop.value = c.firstHop.mode === 'builtin' ? builtinHop(c.firstHop.domain) : c.firstHop.url;
  syncHopName();
  form.elements.match.value = c.match;
  matchTouched = true; syncMatch();
  form.elements.cnDirect.checked = c.cnDirect;
  $('#proxies').replaceChildren(); c.residential.forEach(row);
  $('#form-title').textContent = `编辑 · ${c.name}`; $('#delete').hidden = false; $('#saved-at').textContent = `更新于 ${new Date(c.updatedAt).toLocaleString()}`;
  showLinks(c);
}
function showLinks(c) {
  const root = `${location.origin}/s/${c.id}/${c.token}`;
  const links = [
    ['Mihomo 完整配置', `${root}/mihomo.yaml`],
    ['Shadowrocket 节点订阅', `${root}/shadowrocket.nodes`],
    ['Shadowrocket .conf 规则', `${root}/shadowrocket.conf`]
  ];
  $('#links').replaceChildren();
  for (const [title, url] of links) {
    const box = document.createElement('div'); box.className = 'link-row';
    const label = document.createElement('b'); label.textContent = title;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary'; copy.textContent = '复制地址';
    copy.onclick = async () => { await navigator.clipboard.writeText(url); status('已复制'); };
    const qr = document.createElement('button'); qr.type = 'button'; qr.className = 'secondary'; qr.textContent = '二维码';
    qr.onclick = () => showQr(title, url);
    const actions = document.createElement('div'); actions.className = 'link-actions'; actions.append(copy, qr);
    box.append(label, actions); $('#links').append(box);
  }
  $('#results').hidden = false;
}
// Rendered locally so the tokenised subscription URL never leaves the browser.
function showQr(title, url) {
  const code = qrcode(0, 'M'); code.addData(url); code.make();
  $('#qr-title').textContent = title;
  $('#qr-code').innerHTML = code.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  $('#qr-dialog').showModal();
}
$('#qr-close').onclick = () => $('#qr-dialog').close();
$('#qr-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
async function list() {
  const items = await api('/api/configs');
  $('#list').replaceChildren();
  if (!items.length) { $('#list').textContent = '还没有配置组'; return; }
  for (const item of items) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = item.name;
    btn.classList.toggle('active', item.id === current?.id);
    btn.onclick = async () => { try { fill(await api(`/api/configs/${item.id}`)); await list(); } catch (e) { status(e.message); } };
    $('#list').append(btn);
  }
}
$('#connect').onclick = async () => {
  adminToken = $('#admin').value.trim();
  $('#connect').disabled = true;
  try {
    await list();
    sessionStorage.setItem('adminToken', adminToken);
    if (!current) reset();
    setAuthenticated(true);
    status('已连接');
  } catch (e) { status(e.message); }
  finally { $('#connect').disabled = false; }
};
$('#admin').addEventListener('keydown', event => { if (event.key === 'Enter') $('#connect').click(); });
$('#disconnect').onclick = () => {
  adminToken = '';
  $('#admin').value = '';
  reset();
  setAuthenticated(false);
  status('已断开连接');
};
$('#new').onclick = reset;
$('#add-proxy').onclick = () => row();
form.onsubmit = async e => {
  e.preventDefault();
  const residential = [...$('#proxies').children].map(box => {
    const p = Object.fromEntries([...box.querySelectorAll('[data-key]')].map(el => [el.dataset.key, el.value]));
    return { ...p, udp: p.type === 'socks5' && p.udp === 'true' };
  });
  const data = {
    name: form.elements.name.value, upstreamMihomo: form.elements.upstreamMihomo.value,
    upstreamShadowrocketConf: form.elements.upstreamShadowrocketConf.value,
    firstHop: { url: form.elements.firstHop.value }, match: form.elements.match.value,
    residential, cnDirect: form.elements.cnDirect.checked
  };
  try {
    const saved = await api(current ? `/api/configs/${current.id}` : '/api/configs', {
      method: current ? 'PUT' : 'POST', body: JSON.stringify(data)
    });
    fill(saved); await list(); status('已保存到 KV，订阅地址已生成');
  } catch (err) { status(err.message); }
};
$('#delete').onclick = async () => {
  if (!current || !confirm(`删除「${current.name}」并使其订阅地址失效？`)) return;
  try { await api(`/api/configs/${current.id}`, { method: 'DELETE' }); reset(); await list(); status('已删除'); }
  catch (e) { status(e.message); }
};
reset();
if (adminToken) list().then(() => setAuthenticated(true)).catch(e => status(e.message));
