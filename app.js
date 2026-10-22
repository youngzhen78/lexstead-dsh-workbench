const API_BASE = new URL('api/', location.href).pathname;
const CLIENT_MODE = location.pathname.startsWith('/lexstead/');
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = {
  page: 'home', catalog: { packs: [], agents: [] }, tasks: [], templates: [], status: {},
  current: null, records: new Map(), live: null, optimistic: new Map(), drafts: new Map(),
  pending: new Map(), files: [], pack: 'all', query: '', artifact: null, source: null,
  selectedModel: '', output: '自动', error: '', streamError: '', drawer: null, skills: [],
  submitting: false, creating: false, theme: localStorage.getItem('lexstead-theme') || '#FF4623',
  interactions: [], interactionAnswers: new Map(),
};
const task = () => state.tasks.find(t => t.id === state.current);
const agent = id => state.catalog.agents.find(a => a.id === id);
const date = n => new Date(n).toLocaleString('zh-CN', { hour12: false });
const size = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const symbol = (a, n = 44) => `<span class="mono" style="width:${n}px;height:${n}px;font-size:${n / 2}px">${esc(a?.ch || '律')}</span>`;
const logo = `<span class="lex-logo">LEXSTEAD<i>律师工作台</i></span>`;
let renderTimer;
let followGeneration = 0;
let retryTimer;
let lastCursor = -1;
let hasMore = false;
let modelCatalog;

async function api(url, body) {
  const response = await fetch(API_BASE + url, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || '请求失败');
  return data;
}
function toast(text) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
  $('#toasts').append(el); setTimeout(() => el.remove(), 4000);
}
function notify(error) { state.error = error.message || String(error); toast(state.error); scheduleRender(); }

/** A text-only Markdown renderer: all content is escaped before formatting. */
function inline(text) {
  return esc(text).replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, href) => {
    const raw = href.replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(raw)) return `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    const normalized = raw.replace(/^\.\//, '');
    const file = state.files.find(f => f.path === normalized || f.path.endsWith('/' + normalized));
    if (file) return `<a href="${API_BASE}file?path=${encodeURIComponent(file.path)}" download>${label}</a>`;
    return `${label} <code>${esc(raw)}</code>`;
  }).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function markdown(text) {
  const lines = String(text || '').split('\n'); let out = '', code = [], inCode = false, list = false;
  const closeList = () => { if (list) { out += '</ul>'; list = false; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { closeList(); if (inCode) { out += `<pre><code>${esc(code.join('\n'))}</code></pre>`; code = []; } inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      closeList();
      const row = s => s.trim().replace(/^\||\|$/g, '').split('|');
      out += '<div class="table-scroll"><table><thead><tr>' + row(line).map(c => `<th>${inline(c.trim())}</th>`).join('') + '</tr></thead><tbody>'; i++;
      while ((lines[i + 1] || '').includes('|') && lines[i + 1].trim()) { i++; out += '<tr>' + row(lines[i]).map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>'; }
      out += '</tbody></table></div>'; continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) { closeList(); const n = Math.min(heading[1].length + 1, 6); out += `<h${n}>${inline(heading[2])}</h${n}>`; }
    else if (/^\s*([-*+]\s|\d+[.)]\s)/.test(line)) { if (!list) { out += '<ul>'; list = true; } out += `<li>${inline(line.replace(/^\s*([-*+]\s|\d+[.)]\s)/, ''))}</li>`; }
    else { closeList(); if (/^---+$/.test(line.trim())) out += '<hr>'; else if (line.trim()) out += `<p>${inline(line)}</p>`; }
  }
  closeList(); if (inCode) out += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
  return out;
}
function eventText(event) {
  return (event.data?.message?.content || event.data?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}
function streamText(stream) {
  return (stream || []).map(r => r.type === 'text-chunks' ? r.texts.join('') : r.type === 'chunk' && r.chunk?.type === 'text-delta' ? r.chunk.text : '').join('');
}
function records() { return [...state.records.values()].sort((a, b) => a.seq - b.seq); }
function isRunning() {
  const events = records();
  const last = [...events].reverse().find(e => e.type === 'turn/start' || e.type === 'turn/end');
  return !!state.live || state.submitting || last?.type === 'turn/start';
}
function applyEvent(event, replay = false) {
  const op = event.surfaceOp;
  if (op?.op === 'replace') for (const [seq] of state.records) if (seq >= op.startSeq && seq <= op.endSeq) state.records.delete(seq);
  state.records.set(event.seq, event);
  if (event.type === 'user/message') {
    const requestId = event.data?.source?.rpcId || event.data?.message?.source?.rpcId;
    if (requestId) state.optimistic.delete(requestId);
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') state.live = null;
  if (event.type === 'turn/end' && !replay) {
    state.live = null;
    refreshFiles().catch(notify);
    api('tasks').then(tasks => { state.tasks = tasks; scheduleRender(); }).catch(notify);
    const latest = [...records()].reverse().find(e => e.type === 'assistant/message' && eventText(e));
    if (latest) state.artifact = { seq: latest.seq, text: eventText(latest), title: task()?.title || '工作成果' };
  }
}
function follow(id) {
  state.source?.close(); clearTimeout(retryTimer); const generation = ++followGeneration;
  state.streamError = ''; state.records = new Map(); state.live = null;
  const source = new EventSource(API_BASE + 'follow?id=' + encodeURIComponent(id)); state.source = source;
  source.addEventListener('frame', event => {
    if (state.current !== id || generation !== followGeneration) return;
    const value = JSON.parse(event.data); state.streamError = '';
    if (value.type === 'snapshot') {
      state.records = new Map(); lastCursor = value.cursor; hasMore = value.hasMore;
      for (const r of value.records) if (r.type === 'event') applyEvent(r.event, true);
      const active = value.assistantStream?.activeAttempt;
      state.live = active ? { id: active.attemptId, text: streamText(active.stream), nextIndex: active.nextIndex } : null;
      const selection = value.projections?.values?.modelSelection?.next;
      if (selection) state.selectedModel = JSON.stringify(selection);
      const latest = [...records()].reverse().find(e => e.type === 'assistant/message' && eventText(e));
      if (!state.artifact && latest) state.artifact = { seq: latest.seq, text: eventText(latest), title: task()?.title || '工作成果' };
    } else if (value.type === 'event') applyEvent(value.event);
    else if (value.type === 'assistant-stream') {
      const f = value.frame;
      if (f.type === 'start') state.live = { id: f.attemptId, text: '', nextIndex: 0 };
      if (f.type === 'chunk' && state.live?.id === f.attemptId && f.index === state.live.nextIndex) {
        state.live.nextIndex++;
        if (f.chunk.type === 'text-delta') state.live.text += f.chunk.text;
      }
      if (f.type === 'end') state.live = null;
    }
    scheduleRender();
  });
  const failed = message => {
    if (generation !== followGeneration) return;
    state.streamError = message; source.close(); scheduleRender();
    retryTimer = setTimeout(() => { if (state.current === id) follow(id); }, 2500);
  };
  source.addEventListener('failure', e => failed(JSON.parse(e.data).error));
  source.onerror = () => failed('连接中断，正在重新读取会话…');
}
async function openTask(id) {
  state.current = id; state.artifact = null; state.page = 'chat'; state.error = ''; state.selectedModel = '';
  state.optimistic.clear(); follow(id); render();
  history.replaceState(null, '', '#task=' + encodeURIComponent(id));
}
async function create(agentId = null) {
  if (state.creating) return;
  state.creating = true; scheduleRender();
  try {
    const t = await api('create', { agentId }); state.tasks.unshift(t); state.drawer = null;
    await openTask(t.id);
    return t;
  } finally { state.creating = false; scheduleRender(); }
}
async function refreshFiles() { state.files = await api('files'); scheduleRender(); }
async function refreshStatus() {
  const result = await api('status'); state.status = result; state.tasks = result.tasks; state.templates = result.templates;
  modelCatalog = result.models; scheduleRender();
}
function options() {
  return `<option value="">使用 DSH 默认模型</option>` + (modelCatalog?.groups || []).flatMap(group => group.models.map(m => {
    const value = JSON.stringify({ provider: group.id, model: m.id, ...(m.reasoning ? { reasoningEffort: m.reasoning.defaultEffort || 'high' } : {}) });
    const current = state.selectedModel && JSON.parse(state.selectedModel);
    return `<option value="${esc(value)}" ${current?.provider === group.id && current?.model === m.id ? 'selected' : ''}>${esc(group.name + ' · ' + m.name)}</option>`;
  })).join('');
}
function composer() {
  const attachments = state.pending.get(state.current) || [];
  const interaction = state.interactions.find(i => i.agentId === state.current);
  if (interaction) return interactionPanel(interaction);
  return `<div class="comp"><label class="cl" for="composer">委托事项</label>
    <textarea id="composer" rows="3" placeholder="说明目标与背景，或上传材料。Enter 发送，Shift + Enter 换行。">${esc(state.drafts.get(state.current) || '')}</textarea>
    ${attachments.length ? `<div class="chips files-pending">${attachments.map((f, i) => `<span class="chip">${esc(f.name)} <button data-action="remove-upload" data-index="${i}" aria-label="移除 ${esc(f.name)}">×</button></span>`).join('')}</div>` : ''}
    <div class="cf"><button class="chip" data-action="upload" ${state.submitting ? 'disabled' : ''}>＋ 上传材料</button><input type="file" multiple id="file-input" hidden>
    <span class="sp"></span><label class="msel"><span>成果</span><select id="output">${['自动', '研究报告', '表格', '文书初稿'].map(o => `<option ${state.output === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label class="msel model-select"><span>模型</span><select id="model" aria-label="选择模型">${options()}</select></label>
    ${isRunning() ? '<button class="btn" data-action="cancel">停止办理</button>' : ''}<button class="btn primary" data-action="send" ${!state.status.connected || state.submitting || isRunning() ? 'disabled' : ''}>${state.submitting ? '提交中…' : '委派办理'}</button></div>
    <div class="composer-note">材料按当前 DSH 模型配置处理。上传不会自动脱敏，请按所需范围提供资料。</div></div>`;
}
function interactionPanel(interaction) {
  const request = interaction.request;
  if (interaction.event === 'approval/request') {
    const tool = records().find(e => e.type === 'tool/call' && e.data.callId === request.callId);
    return `<div class="interaction-panel"><b>需要你授权 · ${esc(request.toolName)}</b><p>${esc(request.reason || '此操作需要确认后才能执行。')}</p>${tool ? `<pre>${esc(tool.data.arguments)}</pre>` : ''}<div class="row"><button class="btn" data-action="approval" data-id="${interaction.eventId}" data-value="rejected">拒绝</button><button class="btn primary" data-action="approval" data-id="${interaction.eventId}" data-value="allowed-once">仅允许本次</button></div></div>`;
  }
  return `<div class="interaction-panel"><b>请补充确认</b>${request.questions.map(q => {
    const answer = state.interactionAnswers.get(interaction.eventId + ':' + q.id) || { selected: [], custom: '' };
    return `<fieldset><legend>${esc(q.header || '')} ${esc(q.question)}</legend>${q.detail ? `<div class="markdown">${markdown(q.detail)}</div>` : ''}${(q.options || []).map(o => `<label class="question-option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="question-${esc(q.id)}" data-question="${esc(q.id)}" data-event="${interaction.eventId}" value="${esc(o.label)}" ${answer.selected.includes(o.label) ? 'checked' : ''}>${esc(o.label)}${o.description ? `<span>${esc(o.description)}</span>` : ''}</label>`).join('')}<input class="f question-custom" data-question="${esc(q.id)}" data-event="${interaction.eventId}" placeholder="补充说明或自定义回答" value="${esc(answer.custom)}"></fieldset>`;
  }).join('')}<button class="btn primary" data-action="answer-question" data-id="${interaction.eventId}">提交回答</button></div>`;
}
function header() {
  return `<header class="lh"><button class="lhbrand" data-action="page" data-id="home">${logo}</button><nav class="lhn" aria-label="主导航">${[['home', '首页'], ['chat', '工作台'], ['files', '资料与成果'], ['activity', '运行记录'], ['settings', '设置']].map(([id, name]) => `<button class="${state.page === id ? 'on' : ''}" data-action="page" data-id="${id}">${name}</button>`).join('')}</nav>
    <div class="lhr"><button class="connection ${state.status.connected ? 'ok' : ''}" data-action="refresh"><i></i>${state.status.connected ? 'DSH 已连接' : 'DSH 未连接'}</button><button class="ib" data-action="theme" aria-label="切换配色">配色</button><span class="uav">本</span><span class="un">本机工作空间<span class="mut">单用户版</span></span></div></header>`;
}
function skyline() {
  return `<svg class="lex-sky" viewBox="0 0 700 300" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1">${Array.from({ length: 17 }, (_, i) => {
    const h = 55 + (i * 53 % 155), x = i * 40;
    return `<path d="M${x} 290V${290 - h}h32v${h}"/>${Array.from({ length: Math.floor(h / 16) }, (_, j) => `<path d="M${x + 5} ${280 - j * 16}h22"/>`).join('')}`;
  }).join('')}</g></svg>`;
}
function agentCard(a, index) {
  return `<article class="ar"><button class="agent-symbol" data-action="detail" data-id="${a.id}" aria-label="了解 ${esc(a.short)}">${symbol(a)}</button><div class="arm"><div class="ar-n">${esc(a.short)}<span class="aidx">${String(index + 1).padStart(2, '0')} / WORKFLOW</span></div><p>${esc(a.tag)}</p><div class="ar-tags"><span>${esc(a.cat || state.catalog.packs.find(p => p.id === a.pack)?.name)}</span><span>律师复核</span></div></div><div class="arr"><button class="btn primary" data-action="start" data-id="${a.id}" ${state.creating || !state.status.connected ? 'disabled' : ''}>开始使用</button></div></article>`;
}
function home() {
  const matches = state.catalog.agents.filter(a => (state.pack === 'all' || a.pack === state.pack) && (a.short + a.tag).includes(state.query));
  const catalog = state.pack === 'mine' ? state.templates.map(t => `<article class="ar">${symbol(agent(t.agentId))}<div class="arm"><div class="ar-n">${esc(t.name)}</div><p>${esc(t.prompt.slice(0, 100))}</p><span class="mut">我的任务模板</span></div><button class="btn primary" data-action="template-use" data-id="${t.id}">使用模板</button></article>`).join('') : matches.map(agentCard).join('');
  return `<section class="hx">${skyline()}<div class="hx-eyebrow">LEXSTEAD · 律师的 AI 工作台</div><h1>让专业经验<br>持续发挥价值</h1><i class="redline"></i><p>交代目标，提供材料，领取可以继续修改的工作成果。<br>把时间留给专业判断与客户沟通。</p><div class="hx-cta"><button class="red" data-action="start" data-id="contract">审查一份合同</button><button data-action="start" data-id="minutes">整理会议纪要</button><button data-action="new">开始新委托 ↗</button></div></section>
    <section class="facts"><div><b>${state.catalog.agents.length} 项工作入口</b><span>研究、文书、客户服务与品牌运营</span></div><div><b>真实任务执行</b><span>对话与工具过程实时返回</span></div><div><b>成果留存</b><span>查看、复制，导出 Markdown 与 Word</span></div><div><b>经验复用</b><span>保存任务模板，延续自己的工作方式</span></div></section>
    <div class="trio"><span><b>交代目标</b>说明问题与材料</span><i>→</i><span><b>执行办理</b>查看真实进度</span><i>→</i><span><b>领取成果</b>预览与下载文件</span><i>→</i><span><b>律师复核</b>确认后继续使用</span></div>
    <section class="rsec"><div class="rs-head"><h2>工作工具包</h2><span class="mut">选择工作入口，围绕你的材料开始办理。</span></div><div class="rs-grid"><nav class="rs-menu" aria-label="工具包分类">${[{ id: 'all', name: '全部工具' }, ...state.catalog.packs, { id: 'mine', name: '我的模板' }].map(p => `<button class="${state.pack === p.id ? 'on' : ''}" data-action="pack" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</nav><div id="agent-grid">${catalog || '<div class="empty">没有符合条件的内容。</div>'}</div><aside class="rs-side"><h4>搜索工作</h4><input class="f" id="search" type="search" value="${esc(state.query)}" placeholder="合同、简介、纪要…" aria-label="搜索工具包"><div class="hot"><h4>常用工作</h4><div class="chips">${['合同', '起草', '纪要', '咨询', '简介', '审校'].map(q => `<button class="chip" data-action="search" data-id="${q}">${q}</button>`).join('')}</div></div><p class="mut catalog-note">工作入口提供任务指导。具体检索、OCR 与配图能力取决于 DSH 已配置的工具。</p></aside></div></section>`;
}
function rail() {
  return `<aside class="rail"><div class="railh"><span class="rh">委托目录</span><span class="mut">${state.tasks.length}</span></div><button class="newc" data-action="new" ${state.creating ? 'disabled' : ''}>＋ 新委托</button>${state.tasks.map(t => `<button class="rit ${t.id === state.current ? 'on' : ''}" data-action="open" data-id="${t.id}"><span class="mut">${esc(agent(t.agentId)?.short || '综合工作')} · ${new Date(t.updatedAt).toLocaleDateString('zh-CN')}</span><span>${esc(t.title)}</span></button>`).join('') || '<p class="empty">还没有委托记录</p>'}</aside>`;
}
function messages() {
  let html = hasMore ? '<button class="btn history-more" data-action="older">加载更早记录</button>' : '';
  const toolNames = new Map();
  for (const e of records()) {
    const d = e.data || {};
    if (e.type === 'user/message' && d.source?.kind === 'user') {
      const raw = eventText(e), text = raw.includes('以下为用户本次委托：\n\n') ? raw.split('以下为用户本次委托：\n\n').slice(1).join('以下为用户本次委托：\n\n') : raw;
      const attachments = (d.content || d.message?.content || []).filter(c => c.type === 'file');
      html += `<div class="mu"><span class="lbl">委托事项</span><div class="user-text">${esc(text)}</div>${attachments.map(f => `<span class="chip">附件 · ${esc(f.attachment?.name || '文件')}</span>`).join('')}</div>`;
    }
    if (e.type === 'assistant/message') {
      const text = eventText(e);
      if (text) html += `<article class="answer"><div class="answer-by">${symbol(agent(task()?.agentId), 30)}<b>办理意见</b><span class="mut">${d.interrupted ? '已停止 · 保留部分内容' : '待律师复核'}</span></div><div class="markdown">${markdown(text)}</div><div class="answer-actions"><button class="chip" data-action="artifact" data-seq="${e.seq}">在成果栏打开 ↗</button><button class="chip" data-action="copy-message" data-seq="${e.seq}">复制</button></div></article>`;
    }
    if (e.type === 'tool/call') { toolNames.set(d.callId, d.name); html += `<details class="execution"><summary><span class="run-dot"></span>调用工具 · ${esc(d.name)}</summary><pre>${esc(d.arguments)}</pre></details>`; }
    if (e.type === 'tool/result') {
      const result = d.message?.content?.find(c => c.type === 'tool-result') || d.result || d;
      const text = JSON.stringify(result, null, 2);
      html += `<details class="execution ${result.isError || d.isError ? 'failed' : ''}"><summary>${result.isError || d.isError ? '工具返回错误' : '工具执行返回'} · ${esc(toolNames.get(result.toolCallId) || '')}</summary><pre>${esc(text.slice(0, 20000))}</pre>${text.length > 20000 ? '<p>界面只显示前 20,000 字符；完整记录保存在 DSH 会话中。</p>' : ''}</details>`;
    }
    if (e.type === 'assistant/attempt') {
      const errors = (d.stream || []).filter(r => r.type === 'chunk' && /error/.test(r.chunk?.type || ''));
      if (errors.length) html += `<div class="error-banner">${esc(errors.map(r => r.chunk.message || JSON.stringify(r.chunk)).join('\n'))}</div>`;
    }
    if (e.type === 'turn/end') {
      const kind = d.reason?.kind;
      const label = kind === 'aborted' ? '已停止办理' : kind === 'completed' ? '本轮办理完成' : '本轮已结束 · 请查看执行记录';
      html += `<div class="turn-end">${label}<span>${date(e.time)}</span></div>`;
    }
  }
  for (const p of state.optimistic.values()) html += `<div class="mu"><span class="lbl">${p.failed ? '提交结果未确认' : '正在提交'}</span>${esc(p.text)}${p.failed ? `<button class="btn sm" data-action="retry" data-id="${p.requestId}">用相同标识重试</button>` : ''}</div>`;
  if (state.live) html += `<article class="answer live"><div class="answer-by"><span class="run-dot"></span><b>${state.live.text ? '正在撰写…' : '正在思考与处理…'}</b></div><div class="markdown">${markdown(state.live.text)}</div></article>`;
  else if (isRunning()) html += '<div class="waiting"><span class="run-dot"></span>正在办理，等待下一步执行结果…</div>';
  return html;
}
function artifacts() {
  const a = state.artifact;
  const taskFiles = state.files.filter(f => f.path.startsWith(state.current + '/'));
  const siblings = records().filter(e => e.type === 'assistant/message' && eventText(e));
  if (!a) return `<div class="aph"><div class="apd"></div><b>工作成果</b><p>办理意见与生成文件会显示在这里。<br>可以复制、下载并记录复核。</p></div>${fileList(taskFiles, true)}`;
  const reviewed = task()?.reviewed?.some(r => r.seq === a.seq);
  return `<div class="arth"><b>${esc(a.title)}</b><span class="stm ${reviewed ? 'ok' : 'gray'}">${reviewed ? '已记录复核' : '待律师复核'}</span></div><div class="artb"><button class="btn sm" data-action="copy-artifact">复制</button><button class="btn sm" data-action="export" data-id="md">Markdown</button><button class="btn sm" data-action="export" data-id="docx">导出 Word</button><button class="btn sm" data-action="save-template">存为模板</button><button class="btn sm" data-action="close-artifact">关闭</button></div>
    ${siblings.length > 1 ? `<div class="artifact-versions">${siblings.map((e, i) => `<button class="chip ${e.seq === a.seq ? 'on' : ''}" data-action="artifact" data-seq="${e.seq}">第 ${i + 1} 份</button>`).join('')}</div>` : ''}
    <div class="markdown artifact-body">${markdown(a.text)}</div><div class="artf"><div class="row"><button class="btn ${reviewed ? '' : 'seal'}" data-action="review">${reviewed ? '撤销复核记录' : '记录本人已复核'}</button></div><p class="mut">此记录用于本机工作留痕，不代表团队审批或自动合规认证。</p></div>${fileList(taskFiles, true)}`;
}
function chat() {
  const t = task(), a = agent(t?.agentId), empty = !records().some(e => ['user/message', 'assistant/message', 'turn/start'].includes(e.type)) && !state.optimistic.size;
  return `<div class="wb">${rail()}<section class="wbc">${t ? `<div class="chat-heading"><b>${esc(t.title === '新委托' ? a?.short || '新委托' : t.title)}</b><span class="mut">${esc(a?.short || '综合工作')} · ${isRunning() ? '办理中' : '就绪'}</span></div>${state.streamError ? `<div class="error-banner">${esc(state.streamError)}</div>` : ''}${state.error ? `<div class="error-banner">${esc(state.error)}<button data-action="dismiss-error">×</button></div>` : ''}${empty ? `<div class="wbs"><div class="hero">${symbol(a, 72)}<h1>${esc(a?.short || '请说明委托事项')}</h1><p class="sub">${esc(a?.tag || '提供目标与材料，开始一项新的工作。')}</p><div class="skl">${(a?.starters || []).map(s => `<button class="skc" data-action="example" data-value="${esc(s)}">${esc(s)}</button>`).join('')}</div></div></div>` : `<div class="msgs" id="msgs" aria-live="polite">${messages()}</div>`}<div class="compwrap">${composer()}</div>` : `<div class="wbs"><div class="hero"><div>${logo}</div><h1>开始一项新的工作</h1><p class="sub">选择左侧委托继续办理，或创建一个新委托。</p><button class="btn primary" data-action="new">＋ 新建委托</button></div></div>`}</section><aside class="artp ${state.artifact ? '' : 'e'}" aria-label="工作成果">${artifacts()}</aside></div>`;
}
function fileList(list, compact = false) {
  if (!list.length) return compact ? '' : '<div class="empty">工作目录暂无文件。上传材料后，可在对话中请助手整理并保存成果。</div>';
  return `<div class="${compact ? 'artifact-files' : 'file-list'}"><h3>${compact ? '本委托文件' : '工作目录文件'}</h3>${list.map(f => `<div class="file-row"><div><b>${esc(f.name)}</b><span class="mut">${esc(f.path)} · ${size(f.bytes)}</span></div><a class="btn sm" href="${API_BASE}file?path=${encodeURIComponent(f.path)}" download>下载</a>${/\.(txt|md|csv|json)$/.test(f.name) ? `<button class="btn sm" data-action="preview-file" data-id="${esc(f.path)}">预览</button>` : ''}</div>`).join('')}</div>`;
}
function filesPage() {
  return `<section class="page-body"><div class="page-head"><div><span class="eyebrow">WORKSPACE</span><h1>资料与成果</h1><p class="sub">工作目录中的真实文件，可下载并继续使用。</p></div><button class="btn" data-action="refresh-files">刷新文件</button></div><div class="notice">上传材料绑定到对应 DSH 会话；此处列出助手保存到工作目录的文件。当前尚未配置独立的向量知识库与团队权限检索。</div>${fileList(state.files)}</section>`;
}
function activity() {
  return `<section class="page-body"><div class="page-head"><div><span class="eyebrow">ACTIVITY</span><h1>运行记录</h1><p class="sub">本工作台创建的真实委托与复核记录。</p></div></div><div class="facts activity-facts"><div><b>${state.tasks.length}</b><span>委托总数</span></div><div><b>${state.files.length}</b><span>工作目录文件</span></div><div><b>${state.tasks.reduce((n, t) => n + (t.reviewed?.length || 0), 0)}</b><span>复核记录</span></div><div><b>${state.templates.length}</b><span>个人任务模板</span></div></div><div class="list">${state.tasks.map(t => `<div class="li"><div class="g"><b>${esc(t.title)}</b><div class="mut">${esc(agent(t.agentId)?.short || '综合工作')} · ${date(t.updatedAt)} · ${t.reviewed?.length || 0} 条复核</div></div><button class="btn sm" data-action="open" data-id="${t.id}">查看记录</button></div>`).join('') || '<div class="empty">暂无运行记录</div>'}</div></section>`;
}
function settings() {
  const groups = modelCatalog?.groups || [];
  return `<section class="page-body"><div class="page-head"><div><span class="eyebrow">SETTINGS</span><h1>设置与连接</h1><p class="sub">模型与能力状态来自本机 DSH。</p></div><button class="btn" data-action="refresh">重新检查连接</button></div>
    <div class="settings-grid"><div class="box"><h3>运行环境</h3><div class="setting-line"><span>DSH 服务</span><b>${state.status.connected ? '已连接' : '连接失败'}</b></div><div class="setting-line"><span>执行模式</span><b>本机单用户工作空间</b></div><p class="mut">工作目录</p><code class="path">${esc(state.status.workspace)}</code>${state.status.error ? `<p class="error-banner">${esc(state.status.error)}</p>` : ''}<button class="btn" data-action="native">打开 DSH 管理界面 ↗</button></div>
    <div class="box"><h3>当前模型</h3>${groups.map(g => `<h4>${esc(g.name)}</h4>${g.models.map(m => `<div class="setting-line"><span>${esc(m.name)}</span><span class="tag t-ok">已配置</span></div>`).join('')}`).join('') || '<p>未读取到可用模型</p>'}<p class="mut">默认：${esc(modelCatalog?.default?.model || '未读取')}。可在委托输入框中切换真实可用模型。密钥与提供商配置在 DSH 管理界面维护。</p></div>
    <div class="box"><h3>已安装的 DSH Skills</h3><p class="sub">${state.current ? '读取当前委托可见的实际技能。' : '请先新建或打开一个委托。'}</p><button class="btn" data-action="skills" ${state.current ? '' : 'disabled'}>读取技能目录</button><div class="skill-list">${state.skills.map(s => `<div><b>/${esc(s.name)}</b><p>${esc(s.description)}</p></div>`).join('') || '<p class="mut">尚未读取技能目录</p>'}</div></div>
    <div class="box"><h3>数据与权限</h3><p>当前为本机单用户版，材料按所选模型与 DSH 配置处理。界面未启用自动脱敏、企业身份、案件分级权限与团队审批。</p><p class="mut">页面中的工具包是任务指导入口；实际工具与专用技能由 DSH 配置提供。</p></div></div></section>`;
}
function modal() {
  const a = state.drawer && agent(state.drawer);
  $('#ov').innerHTML = a ? `<div class="scrim" data-action="close-modal"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="工具说明"><button class="btn sm x" data-action="close-modal">关闭</button>${symbol(a, 64)}<h2>${esc(a.short)}</h2><p>${esc(a.tag)}</p><h3>工作要求</h3><p>提供本次任务的真实背景、材料和期望成果。助手根据 DSH 实际可用能力办理，材料不足时补充确认。</p><p class="mut">原型中的人名、案号属于示例，使用前请替换为自己的真实材料。</p><h3>可以这样交代</h3>${a.starters.map(s => `<p>${esc(s)}</p>`).join('')}<button class="btn primary" data-action="start" data-id="${a.id}">开始办理</button></aside>` : '';
}
function render() {
  const focus = document.activeElement;
  const activeId = focus?.id;
  const selection = activeId === 'composer' || activeId === 'search' ? [focus.selectionStart, focus.selectionEnd] : null;
  const messages = $('#msgs');
  const scroll = messages ? { top: messages.scrollTop, bottom: messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100 } : null;
  document.documentElement.style.setProperty('--theme', state.theme);
  document.body.classList.toggle('fixed', state.page === 'chat');
  $('#app').innerHTML = header() + `<main class="stage ${state.page === 'chat' ? 'w' : ''}">${state.page === 'home' ? home() : state.page === 'chat' ? chat() : state.page === 'files' ? filesPage() : state.page === 'activity' ? activity() : settings()}</main>`;
  modal();
  if (activeId && $('#' + activeId)) { $('#' + activeId).focus({ preventScroll: true }); if (selection) $('#' + activeId).setSelectionRange(...selection); }
  const next = $('#msgs'); if (next) next.scrollTop = !scroll || scroll.bottom ? next.scrollHeight : scroll.top;
}
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 65); }

async function send(existing) {
  if (state.submitting) return;
  const id = state.current;
  const text = existing?.text || state.drafts.get(id)?.trim();
  if (!text) return toast('请说明委托事项；可同时上传材料。');
  const request = existing || { id, text, output: state.output, requestId: crypto.randomUUID(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, receipts: (state.pending.get(id) || []).map(f => f.receiptId) };
  state.error = ''; state.submitting = true; request.failed = false; state.optimistic.set(request.requestId, request); render();
  try {
    await api('prompt', request);
    state.drafts.set(id, ''); state.pending.set(id, []);
    state.tasks = await api('tasks');
  } catch (error) { request.failed = true; notify(error); }
  finally { state.submitting = false; scheduleRender(); }
}
async function upload(files) {
  const id = state.current;
  if (!id) return;
  state.submitting = true; render();
  try {
    for (const file of files) {
      if (file.size > 30 * 1024 * 1024) throw new Error('单份材料最大支持 30 MB：' + file.name);
      const response = await fetch(API_BASE + 'upload?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      const result = await response.json(); if (!response.ok || result.error) throw new Error(result.error || '上传失败');
      const pending = state.pending.get(id) || []; pending.push({ name: file.name, receiptId: result.receiptId }); state.pending.set(id, pending);
    }
    toast('材料已上传，填写委托事项后发送。');
  } catch (error) { notify(error); } finally { state.submitting = false; render(); }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function action(name, el) {
  const id = el.dataset.id;
  if (name === 'approval') await api('interaction', { eventId: id, value: el.dataset.value });
  if (name === 'answer-question') {
    const interaction = state.interactions.find(i => i.eventId === id);
    const answers = interaction.request.questions.map(q => ({ id: q.id, ...(state.interactionAnswers.get(id + ':' + q.id) || { selected: [], custom: '' }) }));
    if (answers.some(a => !a.selected.length && !a.custom.trim())) throw new Error('请回答每个问题');
    await api('interaction', { eventId: id, value: { answers } });
  }
  if (name === 'page') { state.page = id; state.drawer = null; history.replaceState(null, '', id === 'chat' && state.current ? '#task=' + encodeURIComponent(state.current) : '#page=' + id); if (id === 'files') await refreshFiles(); render(); window.scrollTo(0, 0); }
  if (name === 'new') await create();
  if (name === 'start') await create(id);
  if (name === 'open') await openTask(id);
  if (name === 'detail') { state.drawer = id; modal(); }
  if (name === 'close-modal') { state.drawer = null; modal(); }
  if (name === 'pack') { state.pack = id; render(); }
  if (name === 'search') { state.query = id; render(); }
  if (name === 'example') { state.drafts.set(state.current, el.dataset.value); render(); $('#composer')?.focus(); }
  if (name === 'send') await send();
  if (name === 'retry') await send(state.optimistic.get(id));
  if (name === 'cancel') { await api('cancel', { id: state.current }); toast('已请求停止，等待 DSH 完成取消。'); }
  if (name === 'upload') $('#file-input').click();
  if (name === 'remove-upload') { state.pending.get(state.current)?.splice(Number(el.dataset.index), 1); render(); }
  if (name === 'refresh') { await refreshStatus(); toast(state.status.connected ? 'DSH 连接正常' : state.status.error); }
  if (name === 'refresh-files') await refreshFiles();
  if (name === 'artifact') { const e = state.records.get(Number(el.dataset.seq)); state.artifact = { seq: e.seq, text: eventText(e), title: task()?.title || '工作成果' }; render(); }
  if (name === 'copy-message') { await navigator.clipboard.writeText(eventText(state.records.get(Number(el.dataset.seq)))); toast('已复制'); }
  if (name === 'copy-artifact') { await navigator.clipboard.writeText(state.artifact.text); toast('已复制'); }
  if (name === 'close-artifact') { state.artifact = null; render(); }
  if (name === 'review') {
    const seq = state.artifact.seq, reviewed = !task()?.reviewed?.some(r => r.seq === seq);
    const updated = await api('review', { id: state.current, seq, reviewed }); Object.assign(task(), updated); render();
  }
  if (name === 'export') {
    const a = state.artifact;
    const response = await fetch(API_BASE + 'export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: state.current, text: a.text, title: a.title, format: id }) });
    if (!response.ok) throw new Error((await response.json()).error);
    download(await response.blob(), a.title.replace(/[\\/:*?"<>|]/g, '_') + '.' + id); await refreshFiles(); toast('已导出，并在项目工作目录保留一份');
  }
  if (name === 'save-template') {
    const users = records().filter(e => e.type === 'user/message');
    const raw = users.length ? eventText(users[users.length - 1]) : '';
    const prompt = raw.split('以下为用户本次委托：\n\n').slice(1).join('以下为用户本次委托：\n\n') || raw;
    const name = window.prompt('为这个任务模板命名', task()?.title || '我的任务模板');
    if (name) { const template = await api('template', { name, prompt, agentId: task()?.agentId }); state.templates.unshift(template); toast('已保存到首页「我的模板」'); }
  }
  if (name === 'template-use') {
    const template = state.templates.find(t => t.id === id); const t = await create(template.agentId);
    if (t) { state.drafts.set(t.id, template.prompt); render(); }
  }
  if (name === 'skills') { const result = await api('skills', { id: state.current }); state.skills = result.skills; render(); if (!state.skills.length) toast('当前委托未发现可调用的 Skills'); }
  if (name === 'native') CLIENT_MODE ? location.assign('/?native=1') : window.open(API_BASE + 'manage', '_blank', 'noopener');
  if (name === 'theme') { state.theme = state.theme === '#FF4623' ? '#263A55' : '#FF4623'; localStorage.setItem('lexstead-theme', state.theme); render(); }
  if (name === 'dismiss-error') { state.error = ''; render(); }
  if (name === 'older') {
    const first = records()[0]?.seq;
    const result = await api('page', { id: state.current, throughSeq: lastCursor, beforeSeq: first });
    for (const r of result.records) if (r.type === 'event') state.records.set(r.event.seq, r.event);
    hasMore = result.hasMore; render();
  }
  if (name === 'preview-file') {
    const response = await fetch(API_BASE + 'file?path=' + encodeURIComponent(id) + '&preview=1');
    if (!response.ok) throw new Error('无法预览文件');
    const text = await response.text();
    $('#ov').innerHTML = `<div class="scrim" data-action="close-modal"></div><div class="modal file-modal" role="dialog" aria-modal="true" aria-label="文件预览"><div class="row"><h2>${esc(id.split('/').pop())}</h2><button class="btn sm" data-action="close-modal">关闭</button></div><div class="markdown">${/\.md$/.test(id) ? markdown(text) : `<pre>${esc(text)}</pre>`}</div></div>`;
  }
}
document.addEventListener('click', e => { const el = e.target.closest('[data-action]'); if (el && !el.disabled) action(el.dataset.action, el).catch(notify); });
document.addEventListener('input', e => {
  if (e.target.classList.contains('question-custom')) {
    const key = e.target.dataset.event + ':' + e.target.dataset.question;
    const answer = state.interactionAnswers.get(key) || { selected: [], custom: '' };
    answer.custom = e.target.value; state.interactionAnswers.set(key, answer);
  }
  if (e.target.id === 'composer') state.drafts.set(state.current, e.target.value);
  if (e.target.id === 'search') { state.query = e.target.value; scheduleRender(); }
});
document.addEventListener('change', e => {
  if (e.target.dataset.question && !e.target.classList.contains('question-custom')) {
    const key = e.target.dataset.event + ':' + e.target.dataset.question;
    const answer = state.interactionAnswers.get(key) || { selected: [], custom: '' };
    answer.selected = e.target.type === 'radio' ? [e.target.value] : e.target.checked ? [...new Set([...answer.selected, e.target.value])] : answer.selected.filter(v => v !== e.target.value);
    state.interactionAnswers.set(key, answer);
  }
  if (e.target.id === 'output') state.output = e.target.value;
  if (e.target.id === 'file-input') upload([...e.target.files]).catch(notify);
  if (e.target.id === 'model') {
    const value = e.target.value;
    const selection = value ? JSON.parse(value) : modelCatalog.default;
    api('model', { id: state.current, ...selection }).then(() => { state.selectedModel = JSON.stringify(selection); toast('已切换模型'); }).catch(notify);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { state.drawer = null; $('#ov').innerHTML = ''; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.id === 'composer') {
    e.preventDefault(); if (!isRunning() && state.status.connected) send().catch(notify);
  }
});
window.addEventListener('beforeunload', () => { state.source?.close(); clearTimeout(retryTimer); });
try {
  const [catalog] = await Promise.all([fetch(new URL('catalog.json', location.href)).then(r => r.json()), refreshStatus(), refreshFiles()]);
  catalog.agents.sort((a, b) => catalog.packs.findIndex(p => p.id === a.pack) - catalog.packs.findIndex(p => p.id === b.pack));
  state.catalog = catalog;
  const interactions = new EventSource(API_BASE + 'interactions');
  interactions.addEventListener('interactions', e => { state.interactions = JSON.parse(e.data); scheduleRender(); });
  interactions.addEventListener('session-error', e => { const value = JSON.parse(e.data); if (state.current === value.id) notify(new Error(value.error)); });
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('task') && state.tasks.some(t => t.id === hash.get('task'))) await openTask(hash.get('task'));
  else { state.page = ['home', 'chat', 'files', 'activity', 'settings'].includes(hash.get('page')) ? hash.get('page') : 'home'; render(); }
} catch (error) { $('#app').innerHTML = `<div class="loading"><h1>工作台暂时无法连接</h1><p>${esc(error.message)}</p><button onclick="location.reload()">重新连接</button></div>`; }
