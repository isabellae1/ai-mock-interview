'use strict';

/* =========================================================
 * AI 面试陪练 v0.1
 * 纯前端：不设服务器，API Key 和数据只保存在浏览器本地
 * ========================================================= */

// ---------------- 模型服务商 ----------------
const PROVIDERS = {
  qwen: {
    name: '通义千问（推荐，支持联网搜索）',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    search: true,
  },
  kimi: {
    name: 'Kimi（不联网，根据 JD 出题）',
    base: 'https://api.moonshot.cn/v1',
    model: 'kimi-latest',
    search: false,
  },
  deepseek: {
    name: 'DeepSeek（不联网，根据 JD 出题）',
    base: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    search: false,
  },
};

const SOURCE_LABELS = {
  interview_report: '🔍 面经',
  company_info: '🏢 公司信息',
  jd: '📄 JD 推测',
  resume: '👤 简历',
  bank: '📚 通用题库',
  custom: '✏️ 自己添加',
};

const DIMENSIONS = [
  ['conclusion', '结论先行'],
  ['structure', '结构清晰'],
  ['data', '具体数据'],
  ['keywords', '岗位关键词'],
];

const PREP_SECONDS = 15;

const FALLBACK_BANK = [
  ['自我介绍', '请做一个 1–2 分钟的自我介绍。'],
  ['动机', '你为什么想加入我们公司、应聘这个岗位？'],
  ['行为', '描述一次你在团队中遇到分歧的经历，你是如何推动达成一致的？'],
  ['行为', '分享一次你在资源或时间有限的情况下，仍然完成目标的经历。'],
  ['项目', '介绍一个你最有成就感的项目，你在其中具体负责什么？结果如何？'],
  ['行为', '讲一次你主动发现问题并提出改进的经历。'],
  ['行为', '请分享一次你通过自学解决陌生问题的经历。'],
  ['规划', '你选择第一份工作时最看重哪些因素？为什么？'],
];

// ---------------- 本地存储（失败时不影响使用） ----------------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  clear() { try { localStorage.removeItem('settings'); localStorage.removeItem('draft'); } catch {} },
};

const DEFAULT_SETTINGS = {
  provider: 'qwen', apiKey: '', model: PROVIDERS.qwen.model,
  qCount: 6, answerSec: 180, followups: 1, autoMic: true,
};
let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };

// ---------------- 工具函数 ----------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const views = ['setupView', 'reviewView', 'interviewView', 'feedbackView', 'reportView'];
function show(viewId) {
  views.forEach((v) => $(v).classList.toggle('hidden', v !== viewId));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function normUrl(u) {
  try { const x = new URL(u); return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase(); }
  catch { return String(u || '').trim().toLowerCase(); }
}

// ---------------- 调用模型 ----------------
class ApiError extends Error {}

function friendlyError(status, text) {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请在「设置」中检查。';
  if (status === 429) return '请求太频繁或额度不足，请稍后再试，或检查账户余额。';
  if (status === 404) return '模型名称或接口地址不对，请在「设置」中检查模型名称。';
  return `模型服务返回错误（${status}）：${String(text).slice(0, 200)}`;
}

async function postJSON(url, body) {
  if (!settings.apiKey) throw new ApiError('请先在「设置」中填写 API Key。');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('网络请求失败，请检查网络连接。');
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(friendlyError(res.status, text));
  try { return JSON.parse(text); } catch { throw new ApiError('模型服务返回的内容无法解析。'); }
}

async function chat(messages, { json = false, temperature = 0.7 } = {}) {
  const p = PROVIDERS[settings.provider];
  const body = { model: settings.model || p.model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };
  const data = await postJSON(`${p.base}/chat/completions`, body);
  return data?.choices?.[0]?.message?.content ?? '';
}

// 通义千问 Responses 接口 + web_search 工具：返回文本和真实检索到的网址
async function searchAndAnswer(system, user) {
  const p = PROVIDERS.qwen;
  const data = await postJSON(`${p.base}/responses`, {
    model: settings.model || p.model,
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    tools: [{ type: 'web_search' }],
  });
  const urls = new Set();
  const texts = [];
  for (const item of data.output || []) {
    if (item.type === 'web_search_call') {
      for (const s of item.action?.sources || []) if (s.url) urls.add(s.url);
    }
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.text) texts.push(c.text);
        for (const a of c.annotations || []) if (a.url) urls.add(a.url);
      }
    }
  }
  if (!texts.length && data.output_text) texts.push(data.output_text);
  return { text: texts.join('\n'), urls: [...urls] };
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

// ---------------- 出题 ----------------
function questionPrompt(withSearch) {
  return `你是一名熟悉中国校园招聘的面试官助手，任务是为求职者生成一轮「AI 视频面试」的模拟题目。

${withSearch ? `请先使用联网搜索，查找：
1. 该公司该岗位（或相近岗位）的面经、面试题、面试形式
2. 该公司的主营业务和近期动态
` : '你无法联网，只能根据 JD 和简历出题。'}
出题要求：
- 共 ${settings.qCount} 道题，第 1 题是自我介绍
- 其余题目覆盖：行为题（STAR 类）、岗位能力题、业务理解题；如果提供了简历，至少 1 道针对简历中具体经历的题
- 题目用面试官的口吻，一句话说清楚，像真实的 AI 面试题

来源标注规则（非常重要，必须遵守）：
- source_type 只能是：interview_report（来自检索到的面经）、company_info（来自检索到的公司信息）、jd（根据 JD 推测）、resume（根据简历）
- 只有当你在检索结果中**确实看到**这道题或非常相近的题时，才能标为 interview_report，并且 source_url 必须填写那个网页的链接
- ${withSearch ? '没有检索到对应来源的题，一律标为 jd 或 resume，source_url 留空。宁可承认没搜到，也不要编造来源。' : '你没有联网，所以 source_type 只能是 jd 或 resume，source_url 留空。'}

只输出一个 JSON 对象，不要输出其他文字，格式如下：
{
  "search_note": "一句话说明是否检索到该岗位的面经",
  "questions": [
    {"question": "题目", "category": "自我介绍/行为/岗位能力/业务理解/项目", "source_type": "jd", "source_url": "", "reason": "为什么出这道题，一句话"}
  ]
}`;
}

function questionUserMessage(f) {
  return `公司：${f.company || '（未填写）'}
岗位：${f.role || '（未填写）'}

岗位描述（JD）：
${f.jd || '（未填写）'}

简历：
${f.resume || '（未提供）'}`;
}

// 代码层面再校验一次：标为面经 / 公司信息的题，链接必须出现在真实的检索结果中，否则降级为「JD 推测」
function enforceSources(questions, urls) {
  const allowed = new Set(urls.map(normUrl));
  let downgraded = 0;
  const cleaned = questions
    .filter((q) => q && q.question)
    .map((q) => {
      let type = SOURCE_LABELS[q.source_type] && q.source_type !== 'bank' && q.source_type !== 'custom' ? q.source_type : 'jd';
      let url = q.source_url || '';
      if (type === 'interview_report' || type === 'company_info') {
        if (!url || !allowed.has(normUrl(url))) { type = 'jd'; url = ''; downgraded++; }
      } else {
        url = '';
      }
      return { question: String(q.question).trim(), category: q.category || '', source_type: type, source_url: url, reason: q.reason || '' };
    });
  return { questions: cleaned, downgraded };
}

async function generateQuestions(form) {
  const p = PROVIDERS[settings.provider];
  const userMsg = questionUserMessage(form);
  let text = '', urls = [], usedSearch = false, searchFailed = false;

  if (p.search) {
    try {
      const r = await searchAndAnswer(questionPrompt(true), userMsg);
      text = r.text; urls = r.urls; usedSearch = true;
    } catch (e) {
      if (/API Key/.test(e.message)) throw e;
      searchFailed = true; // 联网搜索失败，降级为普通对话
    }
  }
  if (!usedSearch) {
    text = await chat([{ role: 'system', content: questionPrompt(false) }, { role: 'user', content: userMsg }], { json: true });
  }

  let parsed = extractJSON(text);
  if (!parsed?.questions) {
    // 格式错误时重试一次
    const retry = await chat([
      { role: 'system', content: '把下面的内容整理成题目要求的 JSON 对象，只输出 JSON。' + questionPrompt(false).split('只输出一个 JSON 对象')[1] },
      { role: 'user', content: text },
    ], { json: true });
    parsed = extractJSON(retry);
  }
  if (!parsed?.questions?.length) throw new ApiError('题目生成失败：模型没有返回有效的题目，请重试或使用通用题库。');

  const { questions, downgraded } = enforceSources(parsed.questions, urls);
  const notes = [];
  if (usedSearch) {
    notes.push(parsed.search_note || '');
    notes.push(urls.length ? `本次联网检索到 ${urls.length} 个网页。` : '本次没有获取到检索来源。');
  } else if (searchFailed) {
    notes.push('联网搜索暂时不可用，以下题目根据 JD 和简历推测。');
  } else {
    notes.push('当前模型不支持联网搜索，以下题目根据 JD 和简历推测。');
  }
  if (downgraded) notes.push(`有 ${downgraded} 道题声称来自网页但找不到对应来源，已改标为「JD 推测」。`);
  if (!questions.some((q) => q.source_type === 'interview_report')) notes.push('未检索到该岗位可核实的公开面经。');
  return { questions, note: notes.filter(Boolean).join(' ') };
}

// ---------------- 追问与评分 ----------------
function transcriptOf(result) {
  return result.turns.map((t, i) => `${i === 0 ? '面试题' : `追问 ${i}`}：${t.q}\n候选人回答：${t.answer || '（未作答）'}`).join('\n\n');
}

async function generateFollowup(result) {
  const sys = `你是一名 AI 视频面试的面试官。根据候选人刚才的回答，提出 1 个追问。
要求：
- 必须引用候选人回答中的具体内容，例如「你刚才提到……，能具体说说……」
- 追问要深挖细节：具体怎么做的、遇到什么困难、结果如何衡量、你个人的贡献是什么
- 如果候选人没有作答或答非所问，就请他针对原问题，结合一个具体经历重新回答
- 只输出追问这一句话，不要输出其他内容`;
  const user = `岗位：${session.form.company} ${session.form.role}
JD：${session.form.jd || '（未提供）'}

${transcriptOf(result)}`;
  const text = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.7 });
  return text.trim().replace(/^["“]|["”]$/g, '');
}

async function scoreAnswer(result) {
  const sys = `你是一名严格但友善的面试教练，为候选人的一道 AI 面试题（含追问）打分。

按 4 个维度打 1–5 分，每个维度一句理由：
- conclusion 结论先行：开头第一句是否直接回答问题
- structure 结构清晰：是否有清楚的结构（如 STAR、分点），逻辑是否连贯
- data 具体数据：是否有具体的数字、结果、事实，而不是空泛的描述
- keywords 岗位关键词：是否体现了 JD 中要求的能力和关键词

评分标准：5 = 非常好，可以直接用于真实面试；3 = 及格，但有明显可改进之处；1 = 没有作答、答非所问或几乎没有内容。
请严格打分，不要因为客气给高分。没有作答的，所有维度都是 1 分。

参考回答要求：
- 基于候选人自己说的经历改写，不要替候选人编造经历
- 候选人没有提供的数据，用【填入你的真实数据】这样的占位符
- 300 字以内，口语化，适合 2–3 分钟说完

只输出一个 JSON 对象：
{
  "scores": {
    "conclusion": {"score": 3, "reason": ""},
    "structure": {"score": 3, "reason": ""},
    "data": {"score": 3, "reason": ""},
    "keywords": {"score": 3, "reason": ""}
  },
  "highlight": "答得好的地方，一句话",
  "improvements": ["改进建议 1", "改进建议 2"],
  "reference_answer": "参考回答"
}`;
  const user = `岗位：${session.form.company} ${session.form.role}
JD：${session.form.jd || '（未提供）'}

${transcriptOf(result)}`;
  let text = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, temperature: 0.3 });
  let parsed = extractJSON(text);
  if (!parsed?.scores) {
    text = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, temperature: 0.3 });
    parsed = extractJSON(text);
  }
  return parsed?.scores ? parsed : { error: true, raw: text };
}

// ---------------- 语音识别 ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = { rec: null, on: false, base: '' };

function startMic() {
  if (!SR) { setStatus($('micStatus'), '当前浏览器不支持语音识别，请直接打字，或使用系统自带的听写功能。'); return; }
  if (mic.on) return;
  mic.on = true;
  mic.base = $('answer').value;
  $('micBtn').textContent = '⏸ 暂停语音';
  setStatus($('micStatus'), '🎙 正在听…（开始打字会自动暂停语音）');

  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let text = '';
    for (const r of e.results) text += r[0].transcript;
    $('answer').value = mic.base + text;
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    const msg = { network: '语音服务连接失败（网络问题），请改用打字或系统听写。', 'not-allowed': '没有麦克风权限，请在浏览器设置中允许。', 'audio-capture': '没有找到麦克风。' }[e.error] || `语音识别出错：${e.error}`;
    stopMic();
    setStatus($('micStatus'), msg, true);
  };
  rec.onend = () => {
    // Chrome 停顿一段时间后会自动结束，作答期间自动重新开始
    if (mic.on) {
      mic.base = $('answer').value;
      try { rec.start(); } catch {}
    }
  };
  mic.rec = rec;
  try { rec.start(); } catch { stopMic(); }
}

function stopMic() {
  mic.on = false;
  if (mic.rec) { try { mic.rec.stop(); } catch {} }
  mic.rec = null;
  $('micBtn').textContent = '🎙 开启语音';
  setStatus($('micStatus'), '');
}

// ---------------- 面试流程 ----------------
let session = null;
let timer = null;

function newSession(form, questions, note) {
  session = { form, questions, note, idx: 0, results: [], startedAt: new Date() };
}

function renderQuestionList() {
  $('searchNote').textContent = session.note || '';
  $('searchNote').classList.toggle('hidden', !session.note);
  $('questionList').innerHTML = session.questions.map((q, i) => `
    <li>
      <div>${esc(q.question)} <button class="ghost del" data-i="${i}" title="删除这道题">删除</button></div>
      <div class="qmeta">
        <span class="badge">${SOURCE_LABELS[q.source_type] || ''}</span>
        ${q.category ? `<span class="badge">${esc(q.category)}</span>` : ''}
        ${q.source_url ? `<a href="${esc(q.source_url)}" target="_blank" rel="noopener">${esc(q.source_url)}</a>` : ''}
        ${q.reason ? `<div>${esc(q.reason)}</div>` : ''}
      </div>
    </li>`).join('');
  $('startBtn').disabled = session.questions.length === 0;
}

function currentResult() { return session.results[session.idx]; }

function startQuestion() {
  const q = session.questions[session.idx];
  session.results[session.idx] = { question: q, turns: [{ q: q.question, answer: '', seconds: 0 }], score: null };
  runTurn();
}

function runTurn() {
  const result = currentResult();
  const turnIdx = result.turns.length - 1;
  const turn = result.turns[turnIdx];
  $('progress').textContent = `第 ${session.idx + 1} / ${session.questions.length} 题`;
  $('qLabel').textContent = turnIdx === 0
    ? (SOURCE_LABELS[result.question.source_type] || '') + (result.question.category ? ` · ${result.question.category}` : '')
    : `追问 ${turnIdx}`;
  $('qText').textContent = turn.q;
  $('answer').value = '';
  setStatus($('interviewStatus'), '');
  setStatus($('micStatus'), '');
  show('interviewView');
  startPrep();
}

function startPrep() {
  clearInterval(timer);
  $('answerArea').classList.add('hidden');
  $('prepActions').classList.remove('hidden');
  let left = PREP_SECONDS;
  const tick = () => {
    $('timer').textContent = `准备时间 ${fmtTime(left)}`;
    $('timer').className = 'timer prep';
    if (left <= 0) { startAnswer(); return; }
    left--;
  };
  tick();
  timer = setInterval(tick, 1000);
}

function startAnswer() {
  clearInterval(timer);
  $('prepActions').classList.add('hidden');
  $('answerArea').classList.remove('hidden');
  $('submitAnswer').disabled = false;
  const total = Number(settings.answerSec);
  const started = Date.now();
  let left = total;
  const tick = () => {
    $('timer').textContent = `作答剩余 ${fmtTime(left)}`;
    $('timer').className = 'timer' + (left <= 15 ? ' low' : '');
    if (left <= 0) { submitAnswer(true); return; }
    left--;
  };
  currentResult().turns.at(-1).startedAt = started;
  tick();
  timer = setInterval(tick, 1000);
  if (settings.autoMic && SR) startMic();
  else $('answer').focus();
}

async function submitAnswer(timeUp = false) {
  clearInterval(timer);
  stopMic();
  $('submitAnswer').disabled = true;
  const result = currentResult();
  const turn = result.turns.at(-1);
  turn.answer = $('answer').value.trim();
  turn.seconds = Math.round((Date.now() - (turn.startedAt || Date.now())) / 1000);
  turn.chars = turn.answer.length;
  $('timer').textContent = timeUp ? '时间到' : '已提交';
  $('timer').className = 'timer';

  const followupsDone = result.turns.length - 1;
  try {
    if (followupsDone < Number(settings.followups)) {
      setStatus($('interviewStatus'), '面试官正在思考追问…');
      const fq = await generateFollowup(result);
      result.turns.push({ q: fq, answer: '', seconds: 0 });
      runTurn();
    } else {
      setStatus($('interviewStatus'), '正在评分…');
      result.score = await scoreAnswer(result);
      renderFeedback(result);
    }
  } catch (e) {
    setStatus($('interviewStatus'), e.message + '（可以点「提交回答」重试）', true);
    $('submitAnswer').disabled = false;
  }
}

function stars(n) {
  const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★'.repeat(v) + '☆'.repeat(5 - v);
}

function feedbackHTML(result) {
  const turns = result.turns.map((t, i) => `
    <div class="turn">
      <div><strong>${i === 0 ? '题目' : `追问 ${i}`}：</strong>${esc(t.q)}</div>
      <div class="muted">你的回答（${t.seconds} 秒，${t.chars || 0} 字）：${esc(t.answer) || '（未作答）'}</div>
    </div>`).join('');
  const s = result.score;
  if (!s || s.error) {
    return turns + `<p class="status error">评分结果解析失败，原始内容如下：</p><div class="ref">${esc(s?.raw || '')}</div>`;
  }
  const rows = DIMENSIONS.map(([k, name]) => `
    <tr><td>${name}</td><td class="stars">${stars(s.scores[k]?.score)}</td><td>${esc(s.scores[k]?.reason)}</td></tr>`).join('');
  const imps = (s.improvements || []).map((x) => `<li>${esc(x)}</li>`).join('');
  return `${turns}
    <table class="scores"><tr><th>维度</th><th>得分</th><th>理由</th></tr>${rows}</table>
    ${s.highlight ? `<p>👍 ${esc(s.highlight)}</p>` : ''}
    ${imps ? `<p><strong>改进建议</strong></p><ul>${imps}</ul>` : ''}
    <p><strong>参考回答</strong></p>
    <div class="ref">${esc(s.reference_answer)}</div>`;
}

function renderFeedback(result) {
  $('feedbackContent').innerHTML = feedbackHTML(result);
  $('nextQuestion').textContent = session.idx < session.questions.length - 1 ? '下一题' : '查看总结';
  show('feedbackView');
}

function nextQuestion() {
  if (session.idx < session.questions.length - 1) {
    session.idx++;
    startQuestion();
  } else {
    renderReport();
  }
}

// ---------------- 总结报告 ----------------
function averages() {
  const scored = session.results.filter((r) => r?.score?.scores);
  const avg = {};
  for (const [k] of DIMENSIONS) {
    const vals = scored.map((r) => Number(r.score.scores[k]?.score) || 0);
    avg[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return { avg, count: scored.length };
}

function renderReport() {
  const { avg, count } = averages();
  const total = DIMENSIONS.reduce((s, [k]) => s + avg[k], 0) / DIMENSIONS.length;
  const weakest = DIMENSIONS.reduce((w, d) => (avg[d[0]] < avg[w[0]] ? d : w));
  const dimRows = DIMENSIONS.map(([k, name]) => `<tr><td>${name}</td><td>${avg[k].toFixed(1)} / 5</td></tr>`).join('');
  const qRows = session.results.map((r, i) => {
    const sc = r?.score?.scores;
    const qa = sc ? (DIMENSIONS.reduce((s, [k]) => s + (Number(sc[k]?.score) || 0), 0) / DIMENSIONS.length).toFixed(1) : '—';
    const secs = r.turns.reduce((s, t) => s + (t.seconds || 0), 0);
    return `<tr><td>${i + 1}. ${esc(r.question.question)}</td><td>${qa}</td><td>${fmtTime(secs)}</td></tr>`;
  }).join('');
  $('reportContent').innerHTML = count ? `
    <p>共完成 ${session.results.length} 道题，平均得分 <strong>${total.toFixed(1)} / 5</strong>。最需要加强的是 <strong>「${weakest[1]}」</strong>。</p>
    <table class="scores"><tr><th>维度</th><th>平均分</th></tr>${dimRows}</table>
    <table class="scores"><tr><th>题目</th><th>得分</th><th>用时</th></tr>${qRows}</table>
    <p class="muted">每道题的详细反馈和参考回答，可以导出为 Markdown 保存。</p>`
    : '<p>本轮没有完成评分的题目。</p>';
  show('reportView');
}

function exportMarkdown() {
  const { avg } = averages();
  const f = session.form;
  const lines = [
    `# 模拟面试记录：${f.company} · ${f.role}`, '',
    `日期：${session.startedAt.toLocaleString('zh-CN')}`, '',
    '## 各维度平均分', '',
    '| 维度 | 平均分 |', '|---|---|',
    ...DIMENSIONS.map(([k, n]) => `| ${n} | ${avg[k].toFixed(1)} |`), '',
  ];
  session.results.forEach((r, i) => {
    lines.push(`## 第 ${i + 1} 题：${r.question.question}`, '');
    lines.push(`来源：${SOURCE_LABELS[r.question.source_type] || ''}${r.question.source_url ? ` ${r.question.source_url}` : ''}`, '');
    r.turns.forEach((t, j) => {
      lines.push(`**${j === 0 ? '题目' : `追问 ${j}`}**：${t.q}`, '', `> ${(t.answer || '（未作答）').replace(/\n/g, '\n> ')}`, '', `用时 ${t.seconds} 秒，${t.chars || 0} 字`, '');
    });
    const s = r.score;
    if (s?.scores) {
      lines.push('| 维度 | 得分 | 理由 |', '|---|---|---|');
      DIMENSIONS.forEach(([k, n]) => lines.push(`| ${n} | ${s.scores[k]?.score ?? ''} | ${(s.scores[k]?.reason || '').replace(/\|/g, '/')} |`));
      lines.push('');
      if (s.improvements?.length) lines.push('**改进建议**', '', ...s.improvements.map((x) => `- ${x}`), '');
      lines.push('**参考回答**', '', s.reference_answer || '', '');
    }
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `模拟面试-${f.company || '记录'}-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------- 设置面板 ----------------
function fillSettings() {
  $('provider').innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  $('provider').value = settings.provider;
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('qCount').value = String(settings.qCount);
  $('answerSec').value = String(settings.answerSec);
  $('followups').value = String(settings.followups);
  $('autoMic').checked = !!settings.autoMic;
  if (!SR) { $('autoMic').checked = false; $('autoMic').disabled = true; }
}

function saveSettings() {
  settings = {
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || PROVIDERS[$('provider').value].model,
    qCount: Number($('qCount').value),
    answerSec: Number($('answerSec').value),
    followups: Number($('followups').value),
    autoMic: $('autoMic').checked,
  };
  store.set('settings', settings);
  $('settingsPanel').classList.add('hidden');
}

// ---------------- 绑定事件 ----------------
function readForm() {
  return {
    company: $('company').value.trim(),
    role: $('role').value.trim(),
    jd: $('jd').value.trim(),
    resume: $('resume').value.trim(),
  };
}

function saveDraft() { store.set('draft', readForm()); }

function init() {
  fillSettings();
  const draft = store.get('draft', null);
  if (draft) ['company', 'role', 'jd', 'resume'].forEach((k) => { $(k).value = draft[k] || ''; });
  ['company', 'role', 'jd', 'resume'].forEach((k) => $(k).addEventListener('input', saveDraft));

  if (!settings.apiKey) $('settingsPanel').classList.remove('hidden');

  $('settingsBtn').onclick = () => $('settingsPanel').classList.toggle('hidden');
  $('provider').onchange = () => { $('model').value = PROVIDERS[$('provider').value].model; };
  $('saveSettings').onclick = saveSettings;
  $('clearData').onclick = () => {
    store.clear();
    settings = { ...DEFAULT_SETTINGS };
    fillSettings();
    ['company', 'role', 'jd', 'resume'].forEach((k) => { $(k).value = ''; });
    alert('已清除本地保存的 API Key 和填写内容。');
  };

  $('generateBtn').onclick = async () => {
    const form = readForm();
    if (!form.company || !form.role) { setStatus($('genStatus'), '请至少填写公司和岗位。', true); return; }
    if (!settings.apiKey) { $('settingsPanel').classList.remove('hidden'); setStatus($('genStatus'), '请先在「设置」中填写 API Key。', true); return; }
    $('generateBtn').disabled = true;
    setStatus($('genStatus'), PROVIDERS[settings.provider].search ? '正在联网搜索面经和公司信息，并生成题目，大约需要 30–60 秒…' : '正在生成题目…');
    try {
      const { questions, note } = await generateQuestions(form);
      newSession(form, questions, note);
      setStatus($('genStatus'), '');
      renderQuestionList();
      show('reviewView');
    } catch (e) {
      setStatus($('genStatus'), e.message, true);
    } finally {
      $('generateBtn').disabled = false;
    }
  };

  $('bankBtn').onclick = () => {
    const form = readForm();
    const qs = FALLBACK_BANK.slice(0, settings.qCount).map(([category, question]) => ({ question, category, source_type: 'bank', source_url: '', reason: '' }));
    newSession(form, qs, '使用的是通用题库，没有针对具体公司和岗位。追问和评分仍需要 API Key。');
    renderQuestionList();
    show('reviewView');
  };

  $('questionList').onclick = (e) => {
    const i = e.target?.dataset?.i;
    if (i === undefined) return;
    session.questions.splice(Number(i), 1);
    renderQuestionList();
  };
  $('addQuestion').onclick = () => {
    const text = $('newQuestion').value.trim();
    if (!text) return;
    session.questions.push({ question: text, category: '', source_type: 'custom', source_url: '', reason: '' });
    $('newQuestion').value = '';
    renderQuestionList();
  };
  $('backToSetup').onclick = () => show('setupView');
  $('startBtn').onclick = () => {
    if (!settings.apiKey) { $('settingsPanel').classList.remove('hidden'); return; }
    session.idx = 0; session.results = []; session.startedAt = new Date();
    startQuestion();
  };

  $('skipPrep').onclick = startAnswer;
  // 语音识别中开始打字：自动暂停语音，避免识别结果覆盖手动输入
  $('answer').addEventListener('beforeinput', () => { if (mic.on) stopMic(); });
  $('micBtn').onclick = () => (mic.on ? stopMic() : startMic());
  $('submitAnswer').onclick = () => submitAnswer(false);
  $('nextQuestion').onclick = nextQuestion;
  $('exportBtn').onclick = exportMarkdown;
  $('restartBtn').onclick = () => show('setupView');
}

init();
