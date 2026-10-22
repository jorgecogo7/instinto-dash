/**
 * Tag Manager API v2 simulada (USE_MOCK_DATA=true). Responde aos mesmos
 * caminhos que o serviço usa, com estado em memória (some ao reiniciar).
 * Nunca chama o Google.
 *
 * Contêineres de teste:
 *   GTM-TESTE01  site com pixel da Meta, GA4 duplicado, conversão do Ads sem vinculador
 *   GTM-TESTE02  contêiner novo, sem nenhuma tag publicada
 *   GTM-SEMPUB1  o usuário só tem leitura (publicar dá 403)
 */
let state = null;
let seq = 100;
const nextId = () => String(++seq);
const fp = () => String(Date.now() + (seq++));

function pageviewContains(id, name, value) {
  return { triggerId: id, name, type: 'pageview', fingerprint: '1700000000000', filter: [{ type: 'contains', parameter: [{ type: 'template', key: 'arg0', value: '{{Page URL}}' }, { type: 'template', key: 'arg1', value }] }] };
}
const pixelHtml = (id) => `<script>\n!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');\nfbq('init', '${id}');\nfbq('track', 'PageView');\n</script>`;

function seed() {
  const t1 = {
    tags: [
      { tagId: '1', name: 'Pixel Meta - Base', type: 'html', firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'html', value: pixelHtml('1234567890123456') }, { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }], fingerprint: '1700000000001' },
      { tagId: '2', name: 'GA4 - Google tag', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'tagId', value: 'G-TESTE12345' }], fingerprint: '1700000000002' },
      { tagId: '3', name: 'GA4 - Google tag (cópia)', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'tagId', value: 'G-TESTE12345' }], fingerprint: '1700000000003' },
      { tagId: '4', name: 'Google Ads - Lead obrigado', type: 'awct', firingTriggerId: ['10'], parameter: [{ type: 'template', key: 'conversionId', value: '987654321' }, { type: 'template', key: 'conversionLabel', value: 'AbCdEfGh123' }], fingerprint: '1700000000004' },
      { tagId: '5', name: 'UA antigo', type: 'ua', paused: true, firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'trackingId', value: 'UA-111-1' }], fingerprint: '1700000000005' },
    ],
    triggers: [pageviewContains('10', 'Página de obrigado', 'obrigado'), { triggerId: '11', name: 'Clique WhatsApp', type: 'linkClick', fingerprint: '1700000000011', filter: [{ type: 'contains', parameter: [{ type: 'template', key: 'arg0', value: '{{Click URL}}' }, { type: 'template', key: 'arg1', value: 'wa.me' }] }] }],
    variables: [{ variableId: '20', name: 'Pixel ID', type: 'c', parameter: [{ type: 'template', key: 'value', value: '1234567890123456' }], fingerprint: '1700000000020' }],
  };
  const mk = (accountId, containerId, publicId, name, live, opts = {}) => ({
    accountId, containerId, publicId, name, usageContext: ['web'], readOnlyPublish: !!opts.readOnlyPublish,
    versions: live ? [{ containerVersionId: '7', name: 'Versão do site', fingerprint: '1760000000000', ...JSON.parse(JSON.stringify(live)) }] : [],
    liveVersionId: live ? '7' : null,
    workspaces: [{ workspaceId: '1', name: 'Default Workspace', baseVersionId: live ? '7' : null, ...JSON.parse(JSON.stringify(live || { tags: [], triggers: [], variables: [] })), builtIns: [] }],
  });
  state = {
    accounts: [
      { accountId: '6000001', name: 'Clínica Teste (simulação)', containers: [mk('6000001', '9000001', 'GTM-TESTE01', 'www.clinicateste.com.br', t1), mk('6000001', '9000002', 'GTM-TESTE02', 'lp.clinicateste.com.br', null)] },
      { accountId: '6000002', name: 'Ótica Teste (simulação)', containers: [mk('6000002', '9000003', 'GTM-SEMPUB1', 'www.oticateste.com.br', t1, { readOnlyPublish: true })] },
    ],
  };
}

function err(status, message) { const e = new Error(message); e.status = status; return e; }
const clone = (o) => JSON.parse(JSON.stringify(o));

function findContainer(a, c) {
  const acc = state.accounts.find((x) => x.accountId === a);
  const cont = acc && acc.containers.find((x) => x.containerId === c);
  if (!cont) throw err(404, 'Not found');
  return cont;
}
function liveOf(cont) { return cont.versions.find((v) => v.containerVersionId === cont.liveVersionId) || null; }
function baseOf(cont, ws) { return cont.versions.find((v) => v.containerVersionId === ws.baseVersionId) || { tags: [], triggers: [], variables: [] }; }
const ENT = { tags: ['tag', 'tagId'], triggers: ['trigger', 'triggerId'], variables: ['variable', 'variableId'] };

function wsStatus(cont, ws) {
  const base = baseOf(cont, ws);
  const changes = [];
  for (const [kind, [single, idKey]] of Object.entries(ENT)) {
    for (const e of ws[kind]) {
      const b = base[kind].find((x) => x[idKey] === e[idKey]);
      if (!b) changes.push({ changeStatus: 'added', [single]: clone(e) });
      else if (b.fingerprint !== e.fingerprint) changes.push({ changeStatus: 'updated', [single]: clone(e) });
    }
  }
  return { workspaceChange: changes, mergeConflict: [] };
}

async function request(method, path, body) {
  if (!state) seed();
  const [p] = path.split('?');
  const seg = p.split('/');
  // accounts
  if (method === 'GET' && p === 'accounts') return { account: state.accounts.map((a) => ({ path: `accounts/${a.accountId}`, accountId: a.accountId, name: a.name })) };
  if (seg[0] !== 'accounts') throw err(404, 'Not found');
  const a = seg[1];
  if (method === 'GET' && seg.length === 3 && seg[2] === 'containers') {
    const acc = state.accounts.find((x) => x.accountId === a);
    if (!acc) throw err(404, 'Not found');
    return { container: acc.containers.map((c) => ({ path: `accounts/${a}/containers/${c.containerId}`, accountId: a, containerId: c.containerId, publicId: c.publicId, name: c.name, usageContext: c.usageContext })) };
  }
  const cont = findContainer(a, seg[3]);
  const rest = seg.slice(4);
  if (method === 'GET' && rest.join('/') === 'versions:live') {
    const live = liveOf(cont);
    if (!live) throw err(404, 'Container has no live version');
    return clone(live);
  }
  if (rest[0] === 'workspaces' && rest.length === 1) {
    if (method === 'GET') return { workspace: cont.workspaces.map((w) => ({ workspaceId: w.workspaceId, name: w.name, description: w.description || '' })) };
    if (method === 'POST') {
      if (cont.workspaces.length >= 3) throw err(400, 'Workspace limit reached');
      const live = liveOf(cont);
      const w = { workspaceId: nextId(), name: body.name, description: body.description || '', baseVersionId: cont.liveVersionId, ...clone(live ? { tags: live.tags, triggers: live.triggers, variables: live.variables } : { tags: [], triggers: [], variables: [] }), builtIns: [] };
      cont.workspaces.push(w);
      return { workspaceId: w.workspaceId, name: w.name, description: w.description };
    }
  }
  if (rest[0] === 'versions' && rest[1] && rest[1].endsWith(':publish') && method === 'POST') {
    if (cont.readOnlyPublish) throw err(403, 'The caller does not have permission');
    const vid = rest[1].split(':')[0];
    const v = cont.versions.find((x) => x.containerVersionId === vid);
    if (!v) throw err(404, 'Not found');
    cont.liveVersionId = vid;
    return { containerVersion: clone(v) };
  }
  if (rest[0] !== 'workspaces') throw err(404, 'Not found');
  const [wid, action] = rest[1].split(':');
  const ws = cont.workspaces.find((w) => w.workspaceId === wid);
  if (!ws) throw err(404, 'Not found');
  if (action === 'sync' && method === 'POST') {
    const live = liveOf(cont);
    if (live && ws.baseVersionId !== live.containerVersionId) ws.baseVersionId = live.containerVersionId;
    return { syncStatus: { syncError: false }, mergeConflict: [] };
  }
  if (action === 'create_version' && method === 'POST') {
    const v = { containerVersionId: String(Math.max(0, ...cont.versions.map((x) => Number(x.containerVersionId))) + 1), name: body.name, description: body.notes || '', fingerprint: String(Date.now()), ...clone({ tags: ws.tags, triggers: ws.triggers, variables: ws.variables }) };
    cont.versions.push(v);
    cont.workspaces = cont.workspaces.filter((w) => w !== ws);
    if (!cont.workspaces.length) cont.workspaces.push({ workspaceId: nextId(), name: 'Default Workspace', baseVersionId: v.containerVersionId, ...clone({ tags: v.tags, triggers: v.triggers, variables: v.variables }), builtIns: [] });
    return { containerVersion: clone(v), newWorkspacePath: `accounts/${a}/containers/${cont.containerId}/workspaces/${cont.workspaces[0].workspaceId}` };
  }
  if (rest.length === 3 && rest[2] === 'status' && method === 'GET') return wsStatus(cont, ws);
  if (rest.length === 3 && rest[2] === 'built_in_variables' && method === 'POST') {
    const types = [...path.matchAll(/type=(\w+)/g)].map((m) => m[1]);
    ws.builtIns = [...new Set([...ws.builtIns, ...types])];
    return { builtInVariable: types.map((t) => ({ type: t })) };
  }
  if (rest.length === 3 && ENT[rest[2]]) {
    const [single, idKey] = ENT[rest[2]];
    if (method === 'GET') return { [single]: clone(ws[rest[2]]) };
    if (method === 'POST') {
      const e = { ...clone(body), [idKey]: nextId(), fingerprint: fp(), accountId: a, containerId: cont.containerId, workspaceId: ws.workspaceId };
      ws[rest[2]].push(e);
      return clone(e);
    }
  }
  throw err(404, 'Not found');
}

module.exports = { request, reset: seed };
