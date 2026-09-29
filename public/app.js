const $ = s => document.querySelector(s);
const form = $('#form');
const defaultConfUrl = new URL('/shadowrocket-default.conf', location.origin).toString();
form.elements.upstreamShadowrocketConf.defaultValue = defaultConfUrl;
form.elements.domain.defaultValue = location.hostname;
let current = null;
let adminToken = sessionStorage.getItem('adminToken') || '';
$('#admin').value = adminToken;

function syncCfFields() {
  const external = form.elements.domain.value.trim().toLowerCase().replace(/\.$/, '') !== location.hostname.toLowerCase().replace(/\.$/, '');
  $('#external-cf-fields').hidden = !external;
  $('#external-cf-hint').hidden = !external;
  $('#local-cf-hint').hidden = external;
  for (const field of [form.elements.uuid, form.elements.wsPath]) {
    field.disabled = !external;
    field.required = external;
  }
}
form.elements.domain.addEventListener('input', syncCfFields);

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
  box.innerHTML = '<div class="proxy-head"><h4>HTTP 住宅节点</h4><button type="button" class="danger remove">移除</button></div><div class="grid"><label>名称<input data-key="name" required placeholder="伊利诺伊"></label><label>服务器<input data-key="server" required placeholder="38.213.131.218"></label><label>端口<input data-key="port" type="number" min="1" max="65535" required placeholder="20000"></label><label>用户名<input data-key="username" required></label><label>密码<input data-key="password" type="password" required></label></div>';
  for (const [k, v] of Object.entries(data)) { const el = box.querySelector(`[data-key="${k}"]`); if (el) el.value = v; }
  box.querySelector('.remove').onclick = () => { if ($('#proxies').children.length > 1) box.remove(); else status('至少保留一个住宅节点'); };
  $('#proxies').append(box);
}
function reset() {
  current = null; form.reset(); $('#proxies').replaceChildren(); row();
  syncCfFields();
  $('#form-title').textContent = '新建配置组'; $('#delete').hidden = true; $('#results').hidden = true; $('#saved-at').textContent = '';
  document.querySelectorAll('#list button').forEach(x => x.classList.remove('active'));
}
function fill(c) {
  current = c; form.elements.name.value = c.name;
  form.elements.upstreamMihomo.value = c.upstreamMihomo;
  form.elements.upstreamShadowrocketConf.value = !c.upstreamShadowrocketConf || c.upstreamShadowrocketConf === '/shadowrocket-default.conf'
    ? defaultConfUrl : c.upstreamShadowrocketConf;
  form.elements.domain.value = c.cf.domain;
  form.elements.uuid.value = c.cf.mode === 'external' ? c.cf.uuid : '';
  form.elements.wsPath.value = c.cf.mode === 'external' ? c.cf.wsPath : '/ws';
  syncCfFields();
  form.elements.rejectUdp443.checked = c.rejectUdp443;
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
    const a = document.createElement('a'); a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noreferrer';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary'; copy.textContent = '复制地址';
    copy.onclick = async () => { await navigator.clipboard.writeText(url); status('已复制'); };
    box.append(label, a, document.createElement('br'), copy); $('#links').append(box);
  }
  $('#results').hidden = false;
}
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
  const residential = [...$('#proxies').children].map(box => Object.fromEntries([...box.querySelectorAll('[data-key]')].map(el => [el.dataset.key, el.value])));
  const data = {
    name: form.elements.name.value, upstreamMihomo: form.elements.upstreamMihomo.value,
    upstreamShadowrocketConf: form.elements.upstreamShadowrocketConf.value,
    cf: { domain: form.elements.domain.value,
      ...(form.elements.uuid.disabled ? {} : { uuid: form.elements.uuid.value, wsPath: form.elements.wsPath.value }) },
    residential, rejectUdp443: form.elements.rejectUdp443.checked
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
