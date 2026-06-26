// ==UserScript==
// @name        沉浸式翻译 (Immersive Translate Lite)
// @namespace   https://minis.app
// @version     3.13.0
// @description 沉浸式翻译精简版 · openai-compatible 自定义渠道 · API 连通测试
// @author      Minis
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_registerMenuCommand
// @connect     api.openai.com
// @connect     api.deepseek.com
// @connect     api.anthropic.com
// @connect     generativelanguage.googleapis.com
// @connect     translate.googleapis.com
// @connect     *
// @run-at      document-end
// @noframes
// @downloadURL https://raw.githubusercontent.com/KeyLiN913/immersive-translate-lite/master/immersive-translate.user.js
// @updateURL   https://raw.githubusercontent.com/KeyLiN913/immersive-translate-lite/master/immersive-translate.user.js
// ==/UserScript==

(function() {
'use strict';

// ══════════════════════════════════
// 0. Store & Config
// ══════════════════════════════════

const Store = {
  _c: {},
  g(k, f) {
    if (this._c[k] !== undefined) return this._c[k];
    try { const v = GM_getValue(k); this._c[k] = v !== undefined ? v : f; }
    catch { this._c[k] = f; }
    return this._c[k];
  },
  s(k, v) { this._c[k] = v; try { GM_setValue(k, v); } catch {} },
};

const BUILTIN = [
  { id:'google-translate', icon:'🆓', name:'Google 翻译', needsKey:0, type:'non-api' },
  { id:'mimo',        icon:'🔮', name:'MiMo',       needsKey:1, model:'mimo-v2.5',              base:'https://token-plan-cn.xiaomimimo.com/v1', type:'oai' },
  { id:'deepseek',    icon:'🐋', name:'DeepSeek',   needsKey:1, model:'deepseek-chat',            base:'https://api.deepseek.com',            type:'oai' },
  { id:'openai',      icon:'🤖', name:'OpenAI',     needsKey:1, model:'gpt-4o-mini',              base:'https://api.openai.com/v1',            type:'oai' },
  { id:'anthropic',   icon:'🧠', name:'Claude',     needsKey:1, model:'claude-sonnet-4-20250514', base:'https://api.anthropic.com/v1',         type:'ant' },
  { id:'google',      icon:'💎', name:'Gemini',     needsKey:1, model:'gemini-2.0-flash',         base:'https://generativelanguage.googleapis.com/v1beta', type:'gg' },
];

const DEF = { provider:'google-translate', apiKey:'', model:'deepseek-chat', baseURL:'', targetLang:'zh-CN', mode:'bilingual', maxBatchSize:12, customPrompt:'', customChannels:'[]' };

function cfg() {
  return {
    provider:Store.g('p',DEF.provider), apiKey:Store.g('k',DEF.apiKey), model:Store.g('m',DEF.model),
    baseURL:Store.g('u',DEF.baseURL), targetLang:Store.g('tl',DEF.targetLang), mode:Store.g('md',DEF.mode),
    maxBatchSize:Store.g('bs',DEF.maxBatchSize), customPrompt:Store.g('cp',DEF.customPrompt),
    customChannels: safeJSON(Store.g('cc',DEF.customChannels)),
  };
}
function safeJSON(s, fallback) { try { return JSON.parse(s); } catch { return fallback || []; } }

// ══════════════════════════════════
// 1. Prompt Engine
// ══════════════════════════════════

const DEFAULT_SYS = `You are a professional {{sourceLanguage}}-to-{{targetLanguage}} translator who needs to fluently translate text into {{targetLanguage}}.

## Translation Rules
1. Output only the translated content, without explanations or additional content
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
4. If input contains %%, use %% in your output, if input has no %%, don't use %% in your output

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input** → Use %% as paragraph separator between translations`;

const DEFAULT_USR = `Translate the following {{sourceLanguage}} text to {{targetLanguage}}:\n\n{{input}}`;

const PE = {
  _custom: '',
  load(t) { this._custom = t || ''; },
  build(input, sl, tl) {
    const replaceLang = s => s.replace(/\{\{sourceLanguage\}\}/g, sl).replace(/\{\{targetLanguage\}\}/g, tl).replace(/\{\{to\}\}/g, tl).replace(/\{\{input\}\}/g, input);
    if (this._custom) {
      return [{role:'system', content: replaceLang(this._custom)}];
    }
    return [
      {role:'system', content: replaceLang(DEFAULT_SYS)},
      {role:'user',   content: replaceLang(DEFAULT_USR)},
    ];
  }
};

// ══════════════════════════════════
// 2. AI Request
// ══════════════════════════════════

class AIReq {
  constructor(c) { this.c = c; }

  // Resolve which provider to use
  _prov() {
    const p = this.c.provider;
    if (p.startsWith('custom:')) {
      const ch = this.c.customChannels.find(x => x.id === p.slice(7));
      if (!ch) throw Error('自定义渠道不存在，请重新选择');
      return {t:'oai', u:ch.url, k:ch.key, m:ch.model||'gpt-4o-mini'};
    }
    if (p === 'google-translate') return {t:'non-api'};
    const b = BUILTIN.find(x => x.id === p);
    if (!b) throw Error('未知提供商: ' + p);
    return {t:b.type, u:this.c.baseURL||b.base, k:this.c.apiKey, m:this.c.model||b.model};
  }

  // Google Translate (free)
  _gt(text, tl) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`,
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        onload: r => { try { const d=JSON.parse(r.responseText); res(d[0].map(s=>s[0]).join('')); } catch { rej(Error('Google解析失败')); } },
        onerror: () => rej(Error('网络错误')),
        timeout: 15000,
      });
    });
  }

  // OpenAI-compatible (also works for DeepSeek, OpenRouter, Groq, SiliconFlow, etc.)
  _oai(msgs, url, key, model) {
    const ep = url.replace(/\/+$/, '') + '/chat/completions';
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: ep,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
        },
        data: JSON.stringify({
          model: model,
          messages: msgs,
          temperature: 0.3,
          max_tokens: 4096,
        }),
        onload: r => {
          try {
            const d = JSON.parse(r.responseText);
            // Handle error responses
            if (d.error) rej(Error(d.error.message || d.error.type || JSON.stringify(d.error)));
            else if (d.choices && d.choices[0]) res(d.choices[0].message?.content || '');
            else rej(Error('无翻译结果: ' + r.responseText.slice(0, 200)));
          } catch { rej(Error('API 响应解析失败')); }
        },
        onerror: () => rej(Error('网络连接失败')),
        timeout: 30000,
      });
    });
  }

  // Anthropic (Claude)
  _ant(msgs, url, key, model) {
    const sm = msgs.find(m => m.role === 'system');
    const um = msgs.filter(m => m.role !== 'system');
    const body = {model, max_tokens:4096, messages:um.map(m=>({role:'user',content:m.content}))};
    if (sm) body.system = sm.content;
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url.replace(/\/+$/, '') + '/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        data: JSON.stringify(body),
        onload: r => {
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) rej(Error(d.error.message));
            else res(d.content?.[0]?.text || '');
          } catch { rej(Error('Claude 响应解析失败')); }
        },
        onerror: () => rej(Error('网络错误')),
        timeout: 30000,
      });
    });
  }

  // Google Gemini
  _gg(msgs, url, key, model) {
    const sm = msgs.find(m => m.role === 'system');
    const um = msgs.filter(m => m.role !== 'system');
    const body = {contents:[{parts:um.map(m=>({text:m.content}))}]};
    if (sm) body.system_instruction = {parts:[{text:sm.content}]};
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url.replace(/\/+$/, '') + '/models/' + model + ':generateContent?key=' + key,
        headers: {'Content-Type':'application/json'},
        data: JSON.stringify(body),
        onload: r => {
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) rej(Error(d.error.message));
            else res(d.candidates?.[0]?.content?.parts?.[0]?.text || '');
          } catch { rej(Error('Gemini 响应解析失败')); }
        },
        onerror: () => rej(Error('网络错误')),
        timeout: 30000,
      });
    });
  }

  translate(text, sl, tl) {
    if (!text?.trim()) return Promise.resolve('');
    const p = this._prov();
    const TIMEOUT = 30000;
    const wrap = (promise) => Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(Error('请求超时 30s')), TIMEOUT))
    ]);
    if (p.t === 'non-api') return wrap(this._gt(text, tl || 'zh-CN'));
    const msgs = PE.build(text, sl || 'auto', tl || 'zh-CN');
    switch (p.t) {
      case 'oai': return wrap(this._oai(msgs, p.u, p.k, p.m));
      case 'ant': return wrap(this._ant(msgs, p.u, p.k, p.m));
      case 'gg':  return wrap(this._gg(msgs, p.u, p.k, p.m));
      default:    return wrap(this._oai(msgs, p.u, p.k, p.m));
    }
  }

  // Test API connection (for custom channels)
  async test() {
    const p = this._prov();
    if (p.t === 'non-api') return {ok:true, msg:'Google 翻译无需 Key'};
    try {
      const r = await this.translate('hello', 'en', 'zh-CN');
      return {ok:!!r, msg: r ? '连接成功: ' + r.slice(0,30) : '返回为空'};
    } catch(e) {
      return {ok:false, msg:e.message};
    }
  }
}

// ══════════════════════════════════
// 3. Translation Hub — 逐条翻译，不拼接
// ══════════════════════════════════

const Hub = {
  _ai: null,
  setConfig(c) { this._ai = new AIReq(c); PE.load(c.customPrompt); },
  // 每条文本独立翻译，返回 Map<key, Promise<string>>
  submit(frags, sl, tl) {
    const ai = this._ai;
    const tgt = tl || 'zh-CN';
    const res = new Map();
    const MAX_CONCURRENT = 4;
    let running = 0;
    const queue = [];

    const drain = () => {
      while (running < MAX_CONCURRENT && queue.length) {
        const {key, text, resolve, reject} = queue.shift();
        running++;
        ai.translate(text, sl || 'auto', tgt)
          .then(r => resolve(cleanOutput(r || text)))
          .catch(reject)
          .finally(() => { running--; drain(); });
      }
    };

    for (const {key, text} of frags) {
      if (!text?.trim()) { res.set(key, Promise.resolve('')); continue; }
      res.set(key, new Promise((resolve, reject) => {
        queue.push({key, text, resolve, reject});
      }));
    }
    drain();
    return res;
  },
};

// 清理 LLM 输出中的分段标记
function cleanOutput(text) {
  if (!text) return text;
  // 将 %% 分段符替换回换行（提示词协议用 %% 做段落分隔）
  return text.replace(/\s*%%\s*/g, '\n').trim();
}

// ══════════════════════════════════
// 4. Node Renderer
// ══════════════════════════════════

const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','TEXTAREA','INPUT','SELECT','OPTION','SVG','CODE','PRE','CANVAS','VIDEO','AUDIO']);
const SKIP_CLS = ['imtr-','imtr-original','imtr-bilingual','notranslate','translate-ignore'];

function isText(node) {
  if (node.nodeType !== 3) return 0;
  const t = node.textContent.trim();
  if (!t || t.length < 2) return 0;
  const p = node.parentElement;
  if (!p || p.closest('.imtr-bilingual,.imtr-original')) return 0;
  let el = p;
  for (let i = 0; i < 5; i++) {
    if (!el) break;
    if (SKIP_TAGS.has(el.tagName)) return 0;
    if (SKIP_CLS.some(c => (el.className||'').includes(c))) return 0;
    el = el.parentElement;
  }
  return 1;
}

const NR = {
  _t: new Map(),
  async go(tl) {
    const c = cfg(); Hub.setConfig(c);
    const frags = [], map = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => isText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    let n, idx = 0;
    while ((n = w.nextNode()) && frags.length < c.maxBatchSize) {
      const key = 'n' + (idx++);
      if (this._t.has(key)) continue;
      frags.push({key, text:n.textContent.trim()});
      map.push({node:n, key});
    }
    if (!frags.length) return;
    const res = Hub.submit(frags, 'auto', tl);
    for (const {node, key} of map) {
      try {
        const tr = await res.get(key);
        if (tr) { this._t.set(key, tr); this._r(node, tr, c.mode); }
      } catch(e) { console.warn('[imtr]', key, e.message); }
    }
  },
  _r(n, t, mode) {
    const p = n.parentElement;
    if (!p) return;
    const orig = n.textContent;
    if (mode === 'replace') {
      n.textContent = t;
      p.classList.add('imtr-original');
      p.dataset.imtrOrig = orig;
    } else {
      const w = document.createElement('span');
      w.className = 'imtr-bilingual';
      w.style.cssText = 'background:linear-gradient(135deg,rgba(139,92,246,0.08),rgba(236,72,153,0.08));border-radius:2px;';
      const os = document.createElement('span'); os.className='imtr-ot'; os.textContent=orig;
      const ts = document.createElement('span'); ts.className='imtr-tt'; ts.textContent=t;
      ts.style.cssText = 'color:#8b5cf6;margin-left:4px;';
      w.append(os, ts);
      p.replaceChild(w, n);
    }
  },
  remove() {
    document.querySelectorAll('.imtr-bilingual').forEach(el => {
      const o = el.querySelector('.imtr-ot');
      el.parentNode.replaceChild(document.createTextNode(o ? o.textContent : el.textContent), el);
    });
    document.querySelectorAll('.imtr-original[data-imtr-orig]').forEach(el => {
      el.textContent = el.dataset.imtrOrig;
      el.classList.remove('imtr-original');
      delete el.dataset.imtrOrig;
    });
    this._t.clear();
  }
};

// ══════════════════════════════════
// 5. Page Interceptor (MutationObserver)
// ══════════════════════════════════

const INT = {
  _ob: null, _busy: 0, _on: 0,
  start(tl) { if (this._on) return; this._on=1; this._x(tl); this._obs(tl); },
  stop() { this._on=0; if (this._ob) { this._ob.disconnect(); this._ob=null; } },
  async _x(tl) { if (this._busy) return; this._busy=1; try{await NR.go(tl);}finally{this._busy=0;} },
  _obs(tl) {
    if (this._ob) this._ob.disconnect();
    let t;
    this._ob = new MutationObserver(() => { clearTimeout(t); t=setTimeout(() => { if(this._on&&!this._busy) this._x(tl); }, 500); });
    this._ob.observe(document.body, {childList:1, subtree:1});
  }
};// ══════════════════════════════════
// 6. Model Fetcher
// ══════════════════════════════════

function fetchModels(prov, url, key) {
  return new Promise((res, rej) => {
    let u;
    if (prov === 'deepseek') u = 'https://api.deepseek.com/models';
    else if (prov === 'anthropic') return res(['claude-sonnet-4-20250514','claude-haiku-4-5','claude-opus-4-20250514']);
    else if (prov === 'google') return res(['gemini-2.0-flash','gemini-2.5-flash','gemini-2.5-pro']);
    else if (prov === 'openai') u = 'https://api.openai.com/v1/models';
  else if (prov === 'mimo') u = 'https://token-plan-cn.xiaomimimo.com/v1/models';
    else u = url.replace(/\/+$/, '') + '/models';
    GM_xmlhttpRequest({
      method: 'GET', url: u,
      headers: key ? {'Authorization':'Bearer '+key} : {},
      onload: r => {
        try {
          const d = JSON.parse(r.responseText);
          let ms = [];
          if (d.data) ms = d.data.map(m => m.id || m.name).filter(Boolean);
          else if (d.models) ms = d.models.map(m => m.name || m.id).filter(Boolean);
          if (!ms.length) ms = ['gpt-4o-mini','gpt-4o','deepseek-chat'];
          res(ms);
        } catch { rej(Error('解析失败')); }
      },
      onerror: () => rej(Error('网络失败')),
      timeout: 10000,
    });
  });
}

// ══════════════════════════════════
// 7. Channel Manager (must be defined before UI)
// ══════════════════════════════════

function showChannelMgr(refreshCallback) {
  const old = document.getElementById('imtr-cm-modal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'imtr-cm-modal';
  modal.style.cssText = 'position:fixed!important;inset:0;z-index:2147483647!important;background:rgba(0,0,0,.4);display:flex;align-items:flex-end;justify-content:center;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:500px;max-height:85vh;overflow-y:auto;padding:20px;';

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-weight:700;font-size:16px">🔌 自定义渠道 (OpenAI 兼容)</span>
      <span id="imtr-cm-close" style="cursor:pointer;font-size:20px;color:#999">✕</span>
    </div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:12px;line-height:1.5">
      走 OpenAI 兼容接口：<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px">baseURL/chat/completions</code><br>
      支持：DeepSeek、OpenRouter、Groq、SiliconFlow、Together.ai 等任意兼容 API
    </div>
    <div id="imtr-cm-list" style="margin-bottom:12px"></div>
    <div style="border-top:1px solid #eee;padding-top:12px">
      <input id="imtr-cm-name" placeholder="渠道名称" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;margin-bottom:6px;box-sizing:border-box">
      <input id="imtr-cm-url" placeholder="API 地址 (如 https://api.siliconflow.cn/v1)" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-bottom:6px;box-sizing:border-box">
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input id="imtr-cm-key" type="password" placeholder="API Key" style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px">
        <input id="imtr-cm-model" placeholder="模型 (默认 gpt-4o-mini)" style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px">
      </div>
      <div style="display:flex;gap:8px">
        <button id="imtr-cm-add" style="flex:1;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;font-weight:700;font-size:14px;cursor:pointer">+ 添加</button>
      </div>
    </div>
    <div style="margin-top:10px;text-align:right">
      <button id="imtr-cm-done" style="padding:8px 20px;border:none;border-radius:8px;background:#8b5cf6;color:#fff;cursor:pointer;font-size:13px">完成</button>
    </div>
  `;

  modal.appendChild(box);
  document.body.appendChild(modal);

  function getChannels() { return safeJSON(Store.g('cc', DEF.customChannels)); }
  function saveChannels(chs) { Store.s('cc', JSON.stringify(chs)); }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function renderList() {
    const list = document.getElementById('imtr-cm-list');
    const chs = getChannels();
    if (!chs.length) {
      list.innerHTML = '<div style="color:#999;font-size:12px;padding:8px;text-align:center">暂无自定义渠道</div>';
      return;
    }
    list.innerHTML = chs.map((ch, i) => `
      <div style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;background:#f3f4f6;margin-bottom:6px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">${esc(ch.name)}</div>
          <div style="font-size:11px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ch.url)} · ${esc(ch.model||'默认')}</div>
        </div>
        <button data-test="${i}" style="padding:4px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#8b5cf6;cursor:pointer;font-size:11px;margin-left:4px">测试</button>
        <button data-del="${i}" style="padding:4px 8px;border:none;border-radius:6px;background:#fee2e2;color:#ef4444;cursor:pointer;font-size:11px;margin-left:4px">删除</button>
      </div>
    `).join('');

    // Delete handlers
    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.del);
        const chs = getChannels(); chs.splice(idx, 1); saveChannels(chs);
        renderList(); refreshCallback();
      };
    });

    // Test handlers
    list.querySelectorAll('[data-test]').forEach(btn => {
      btn.onclick = async () => {
        const idx = parseInt(btn.dataset.test);
        const ch = getChannels()[idx];
        btn.textContent = '...'; btn.disabled = true;
        try {
          const testCfg = {...cfg(), provider:'custom:'+ch.id, apiKey:ch.key};
          const ai = new AIReq(testCfg);
          const result = await ai.test();
          btn.textContent = result.ok ? '✓ 通' : '✗ 断';
          btn.style.color = result.ok ? '#10b981' : '#ef4444';
          btn.style.borderColor = result.ok ? '#10b981' : '#ef4444';
          if (result.ok) btn.title = result.msg;
          else btn.title = '错误: ' + result.msg;
        } catch(e) {
          btn.textContent = '✗ 断';
          btn.style.color = '#ef4444';
          btn.title = e.message;
        }
        setTimeout(() => { btn.textContent='测试'; btn.disabled=false; btn.style.color='#8b5cf6'; btn.style.borderColor='#d1d5db'; }, 3000);
      };
    });
  }

  // Add handler
  document.getElementById('imtr-cm-add').onclick = () => {
    const name = document.getElementById('imtr-cm-name').value.trim();
    const u = document.getElementById('imtr-cm-url').value.trim();
    const k = document.getElementById('imtr-cm-key').value.trim();
    const m = document.getElementById('imtr-cm-model').value.trim() || 'gpt-4o-mini';
    if (!name) { alert('请填写渠道名称'); return; }
    if (!u) { alert('请填写 API 地址'); return; }
    const chs = getChannels();
    chs.push({ id:'ch_'+Date.now(), name, url:u, key:k, model:m });
    saveChannels(chs);
    renderList(); refreshCallback();
    document.getElementById('imtr-cm-name').value = '';
    document.getElementById('imtr-cm-url').value = '';
    document.getElementById('imtr-cm-key').value = '';
    document.getElementById('imtr-cm-model').value = '';
  };

  document.getElementById('imtr-cm-close').onclick = () => modal.remove();
  document.getElementById('imtr-cm-done').onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  renderList();
}

// ══════════════════════════════════
// 8. Mobile UI
// ══════════════════════════════════

(function mobileUI() {
  // ── 等待 head+body 就绪再注入 ──
  function initUI() {
    if (document.getElementById('imtr-fab')) return;
    if (!document.head || !document.body) { setTimeout(initUI, 200); return; }

  // CSS
  const s = document.createElement('style');
  s.textContent = `
#imtr-fab{position:fixed!important;bottom:24px!important;right:16px!important;z-index:2147483647!important;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:bold;font-family:system-ui,sans-serif;box-shadow:0 4px 16px rgba(139,92,246,0.4);cursor:pointer;user-select:none;transition:transform .15s;touch-action:manipulation;}
#imtr-fab:active{transform:scale(.92)}
#imtr-panel{position:fixed!important;left:0!important;right:0!important;bottom:0!important;z-index:2147483646!important;background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -4px 24px rgba(0,0,0,0.15);max-height:80vh;overflow-y:auto;font:13px/1.5 system-ui,sans-serif;color:#333;transform:translateY(105%);transition:transform .3s cubic-bezier(.32,.72,0,1);}
#imtr-panel.open{transform:translateY(0)}
#imtr-panel input,#imtr-panel select,#imtr-panel textarea{box-sizing:border-box;}
#imtr-overlay{position:fixed!important;inset:0;z-index:2147483645!important;background:rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .3s;}
#imtr-overlay.show{opacity:1;pointer-events:auto;}
@media(min-width:768px){
  #imtr-fab{right:24px;width:56px;height:56px;}
  #imtr-panel{left:auto!important;right:16px!important;width:360px!important;border-radius:16px!important;bottom:90px!important;max-height:70vh;box-shadow:0 8px 32px rgba(0,0,0,0.18)!important;}
}
@media(orientation:landscape) and (max-height:500px){
  #imtr-fab{bottom:12px;right:12px;width:44px;height:44px;}
  #imtr-panel{max-height:90vh;}
}
@keyframes imtr-spin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(s);

  // FAB
  const fab = document.createElement('div');
  fab.id = 'imtr-fab'; fab.textContent = '翻'; fab.title = 'v3.13.0';
  document.body.appendChild(fab);

  // Overlay
  const overlay = document.createElement('div');
  overlay.id = 'imtr-overlay';
  document.body.appendChild(overlay);

  // Panel
  const panel = document.createElement('div');
  panel.id = 'imtr-panel';
  panel.innerHTML = `
<div style="padding:12px 16px 8px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:1;border-radius:16px 16px 0 0">
  <span style="font-weight:700;font-size:15px;background:linear-gradient(135deg,#8b5cf6,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent">🌐 沉浸式翻译</span>
  <div style="display:flex;gap:8px;align-items:center">
    <span id="imtr-save-ok" style="font-size:11px;color:#10b981;opacity:0;transition:opacity .3s">✓</span>
    <span id="imtr-close-btn" style="cursor:pointer;font-size:18px;color:#999">✕</span>
  </div>
</div>
<div style="padding:12px 16px 20px">
  <div id="imtr-status" style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:#f3f4f6;font-size:12px;color:#6b7280;text-align:center">就绪</div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
    <div>
      <label style="font-weight:600;font-size:12px;display:block;margin-bottom:4px">模式</label>
      <select id="imtr-mode" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff">
        <option value="bilingual">双语</option>
        <option value="replace">替换</option>
      </select>
    </div>
    <div>
      <label style="font-weight:600;font-size:12px;display:block;margin-bottom:4px">引擎</label>
      <select id="imtr-provider" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff"></select>
    </div>
  </div>

  <div id="imtr-model-row" style="margin-bottom:8px">
    <label style="font-weight:600;font-size:12px;display:block;margin-bottom:4px">模型</label>
    <div style="display:flex;gap:6px">
      <select id="imtr-model" style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff"></select>
      <button id="imtr-fetch" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;color:#6b7280;font-size:11px;cursor:pointer;white-space:nowrap">获取</button>
    </div>
  </div>

  <div id="imtr-api-row" style="margin-bottom:8px">
    <label style="font-weight:600;font-size:12px;display:block;margin-bottom:4px">API Key</label>
    <input id="imtr-key" type="password" placeholder="Google 翻译不需要" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px">
    <div style="display:flex;gap:6px;margin-top:6px">
      <input id="imtr-url" type="text" placeholder="API 地址 (默认内置)" style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px">
      <button id="imtr-mgr-btn" style="padding:8px 10px;border:1px solid #8b5cf6;border-radius:8px;background:#f3f4f6;color:#8b5cf6;cursor:pointer;font-size:11px;white-space:nowrap;font-weight:600">渠道+</button>
    </div>
  </div>

  <details style="margin-bottom:8px">
    <summary style="font-weight:600;font-size:12px;cursor:pointer;color:#6b7280;padding:4px 0">提示词设置</summary>
    <div style="margin-top:6px;display:flex;align-items:center;margin-bottom:4px">
      <span id="imtr-ps" style="font-size:11px;color:#6b7280"></span>
      <span id="imtr-load-triples" style="font-size:11px;color:#8b5cf6;cursor:pointer;margin-left:auto">加载同人文提示词</span>
    </div>
    <textarea id="imtr-cp" rows="3" placeholder="留空 = 默认提示词; {{to}} = 目标语言" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;font-family:monospace;resize:vertical"></textarea>
  </details>

  <div style="display:flex;gap:8px;margin:10px 0">
    <button id="imtr-go" style="flex:1;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;font-weight:700;font-size:14px;cursor:pointer">翻译此页</button>
    <button id="imtr-undo" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:#6b7280;font-size:14px;cursor:pointer">还原</button>
  </div>

  <div style="background:#f3f4f6;border-radius:8px;padding:8px">
    <div style="font-weight:600;font-size:11px;margin-bottom:4px;color:#6b7280">📝 选中文本翻译</div>
    <div id="imtr-sel-src" style="font-size:12px;color:#6b7280;margin-bottom:4px;word-break:break-all;max-height:50px;overflow:hidden"></div>
    <div id="imtr-sel-res" style="font-size:12px;color:#8b5cf6;word-break:break-all"></div>
  </div>
</div>`;
  document.body.appendChild(panel);

  // ── References ──
  const provSel  = panel.querySelector('#imtr-provider');
  const modelSel = panel.querySelector('#imtr-model');
  const keyInp   = panel.querySelector('#imtr-key');
  const urlInp   = panel.querySelector('#imtr-url');
  const modeSel  = panel.querySelector('#imtr-mode');
  const cpInp    = panel.querySelector('#imtr-cp');
  const goBtn    = panel.querySelector('#imtr-go');
  const undoBtn  = panel.querySelector('#imtr-undo');
  const status   = panel.querySelector('#imtr-status');
  const fetchBtn = panel.querySelector('#imtr-fetch');
  const mgrBtn   = panel.querySelector('#imtr-mgr-btn');
  const psSpan   = panel.querySelector('#imtr-ps');
  const loadTriples = panel.querySelector('#imtr-load-triples');
  const saveOk   = panel.querySelector('#imtr-save-ok');
  const selSrc   = panel.querySelector('#imtr-sel-src');
  const selRes   = panel.querySelector('#imtr-sel-res');

  let panelOpen = false;
  function showPanel() { panelOpen = true; panel.classList.add('open'); overlay.classList.add('show'); }
  function hidePanel() { panelOpen = false; panel.classList.remove('open'); overlay.classList.remove('show'); }

  fab.onclick = () => panelOpen ? hidePanel() : showPanel();
  overlay.onclick = hidePanel;
  panel.querySelector('#imtr-close-btn').onclick = hidePanel;

  // ── Save indicator ──
  let stm;
  function flashSave() { saveOk.style.opacity = '1'; clearTimeout(stm); stm = setTimeout(() => saveOk.style.opacity = '0', 1500); }

  // ── Render providers ──
  function renderProviders() {
    const cur = Store.g('p', DEF.provider);
    const chs = safeJSON(Store.g('cc', DEF.customChannels));
    provSel.innerHTML = '';
    BUILTIN.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.icon + ' ' + p.name;
      provSel.appendChild(o);
    });
    if (chs.length) {
      const og = document.createElement('optgroup'); og.label = '🔌 自定义';
      chs.forEach(ch => {
        const o = document.createElement('option'); o.value = 'custom:' + ch.id; o.textContent = ch.name;
        og.appendChild(o);
      });
      provSel.appendChild(og);
    }
    provSel.value = cur;
  }

  // ── Toggle visibility ──
  function toggleRows() {
    const v = provSel.value;
    const isCustom = v.startsWith('custom:');
    const bi = BUILTIN.find(x => x.id === v);
    const isNonAPI = bi?.type === 'non-api';
    panel.querySelector('#imtr-model-row').style.display = isNonAPI ? 'none' : 'block';
    panel.querySelector('#imtr-api-row').style.display  = isNonAPI ? 'none' : 'block';

    if (isCustom) {
      const chs = safeJSON(Store.g('cc', DEF.customChannels));
      const ch = chs.find(x => x.id === v.slice(7));
      if (ch) {
        keyInp.value = ch.key || '';
        urlInp.value = ch.url || '';
        setModelValue(ch.model || 'gpt-4o-mini');
      }
    } else if (bi) {
      urlInp.value = bi.base || '';
      if (bi.model) setModelValue(bi.model);
    }
  }

  // 确保 modelSel 有对应 option
  function setModelValue(val) {
    const exists = Array.from(modelSel.options).some(o => o.value === val);
    if (!exists) {
      const o = document.createElement('option');
      o.value = val; o.textContent = val;
      modelSel.appendChild(o);
    }
    modelSel.value = val;
  }

  // ── Load stored values ──
  function loadStored() {
    const c = cfg();
    keyInp.value = c.apiKey; urlInp.value = c.baseURL;
    setModelValue(c.model);
    modeSel.value = c.mode; cpInp.value = c.customPrompt;
    psSpan.textContent = c.customPrompt ? '✅ 自定义' : '';
    renderProviders(); toggleRows();
  }

  // ── Events ──
  provSel.onchange = () => { Store.s('p', provSel.value); toggleRows(); flashSave(); };
  keyInp.oninput    = () => { Store.s('k', keyInp.value); };
  urlInp.oninput    = () => { Store.s('u', urlInp.value); };
  modeSel.onchange  = () => { Store.s('md', modeSel.value); };
  modelSel.onchange = () => { Store.s('m', modelSel.value); };
  cpInp.oninput     = () => { Store.s('cp', cpInp.value); psSpan.textContent = cpInp.value ? '✅' : ''; PE.load(cpInp.value); };

  // ── Channel manager button ──
  mgrBtn.onclick = () => {
    showChannelMgr(() => {
      renderProviders();
      toggleRows();
    });
  };

  // ── Fetch models ──
  fetchBtn.onclick = async () => {
    const pv = Store.g('p', DEF.provider);
    if (!keyInp.value && !pv.startsWith('custom:')) { status.textContent = '⚠️ 需要 API Key'; return; }
    status.textContent = '⏳ 获取模型中...';
    try {
      const ms = await fetchModels(pv, urlInp.value, keyInp.value);
      modelSel.innerHTML = '';
      ms.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; modelSel.appendChild(o); });
      Store.s('m', modelSel.value);
      status.textContent = '✅ ' + ms.length + ' 个模型';
    } catch(e) { status.textContent = '❌ ' + e.message; }
  };

  // ── Translate ──
  goBtn.onclick = async () => {
    try {
    const c = cfg();
    // For custom channels, read key/url from inputs (user may have changed them)
    if (c.provider.startsWith('custom:')) {
      const chs = safeJSON(Store.g('cc', DEF.customChannels));
      const ch = chs.find(x => x.id === c.provider.slice(7));
      if (!ch) { status.textContent = '⚠️ 自定义渠道已删除，请重新选择'; return; }
      c.apiKey = ch.key;
      c.baseURL = ch.url;
      c.model = ch.model || 'gpt-4o-mini';
    }
    const bi = BUILTIN.find(x => x.id === c.provider);
    if (bi && bi.needsKey && !c.apiKey) { status.textContent = '⚠️ 需要 API Key'; return; }
    Hub.setConfig(c);
    status.textContent = '⏳ 翻译中...';
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="imtr-spin" style="display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:imtr-spin .6s linear infinite"></span> 翻译中';
    try {
      INT.stop(); NR.remove();
      await NR.go(c.targetLang);
      INT.start(c.targetLang);
      status.textContent = '✅ 翻译完成';
    } catch(e) { status.textContent = '❌ ' + (e.message||'失败'); }
    } catch(e) { console.error('[imtr] translate error:', e); status.textContent = '❌ ' + (e.message||'未知错误'); }
    finally { goBtn.disabled = false; goBtn.textContent = '翻译此页'; }
  };

  undoBtn.onclick = () => { INT.stop(); NR.remove(); status.textContent = '🔄 已还原'; };

  // ── Load triples prompt ──
  loadTriples.onclick = () => {
    const p = `You are a professional {{to}} native translator who needs to fluently translate text into {{to}}.

## Translation Rules
1. Output only the translated content, without explanations or additional content
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. For content that should not be translated (proper nouns, code, etc.), keep the original text.
4. If input contains %%, use %% in your output, if input has no %%, don't use %% in your output

## OUTPUT FORMAT:
- Single paragraph input → Output translation directly
- Multi-paragraph input → Use %% as paragraph separator

## Context: tripleS 同人文翻译
You are translating TRIPLES (tripleS / 트리플에스) fan fiction originally posted on Postype (포스타입). This is creative writing — translate naturally and emotionally, not literally.

### Member Name Mapping (MANDATORY)
Korean: 윤서연→尹舒姸, 정혜린→郑慧潾, 이지우→李知禹, 김채연→金采嬿, 김유연→金琉然, 김수민→金秀珉, 김나경→金拏炅, 공유빈→孔裕彬, 서다현→徐多贤, 곽연지→郭姸知, 박소현→朴昭玹, 정하연→丁夏妍, 박시온→朴示温, 김채원→金采湲
International: 카에데→枫, 코토네→琴音, 니엔→念, 마유→mayu, 린→凛, 설린→Sullin, 서아→Seoah, 지연→Jiyeon, 주빈→周彬, 신위→心语

### Terminology
tripleS, MODHAUS, WAV (keep as-is), Objekt→数字小卡, Dimension→次元, Gravity→引力
Songs: Keep English titles (Girls Never Die, Generation, Rising, etc.)

### Style
존댓말→polite Chinese, 반말→casual Chinese. Romantic scenes→Chinese romance prose. ㅋㅋㅋ→哈哈, ㅠㅠ→呜呜, ㄹㅇ→真的`;
    cpInp.value = p;
    psSpan.textContent = '✅ 同人文专用';
    Store.s('cp', p);
    PE.load(p);
    flashSave();
  };

  // ── Selection translation ──
  let selTimer;
  document.addEventListener('mouseup', () => {
    const s = window.getSelection()?.toString().trim();
    if (s && s.length > 1 && s.length < 500) {
      selSrc.textContent = s;
      selRes.textContent = '⏳ ...';
      clearTimeout(selTimer);
      selTimer = setTimeout(async () => {
        const c = cfg();
        if (c.provider.startsWith('custom:')) {
          const chs = safeJSON(Store.g('cc', DEF.customChannels));
          const ch = chs.find(x => x.id === c.provider.slice(7));
          if (ch) { c.apiKey = ch.key; c.baseURL = ch.url; c.model = ch.model||'gpt-4o-mini'; }
        }
        const bi = BUILTIN.find(x => x.id === c.provider);
        if (bi && bi.needsKey && !c.apiKey) return;
        Hub.setConfig(c);
        try {
          const r = await (new AIReq(c)).translate(s, 'auto', c.targetLang);
          if (r) selRes.textContent = r;
        } catch(e) { selRes.textContent = '❌ ' + e.message; }
      }, 800);
    }
  });

    // Load on start
    loadStored();
  }

  // 启动 UI（带 body 就绪重试）
  try { initUI(); } catch(e) { console.warn('[imtr] UI init failed:', e); }

  // ── 持久化守卫：Next.js/SPA 重渲染后自动补回 FAB ──
  // 用 requestAnimationFrame 轮询，开销极小，不会被 body 替换断开
  let _guardActive = true;
  function guard() {
    if (!_guardActive) return;
    if (!document.getElementById('imtr-fab') && document.body) {
      initUI();
    }
    requestAnimationFrame(guard);
  }
  requestAnimationFrame(guard);
})();

// ══════════════════════════════════
// 9. GM Menu + 快捷键（独立于 UI，始终执行）
// ══════════════════════════════════

const savedP = Store.g('cp', DEF.customPrompt);
if (savedP) PE.load(savedP);

try {
  GM_registerMenuCommand('📖 翻译面板', () => {
    const f = document.getElementById('imtr-fab');
    if (f) f.click();
    else { const p = document.getElementById('imtr-panel'); if (p) p.classList.toggle('open'); }
  });
  GM_registerMenuCommand('🔄 翻译此页', () => { const b = document.getElementById('imtr-go'); if (b) b.click(); });
  GM_registerMenuCommand('↩️ 还原原文', () => { const b = document.getElementById('imtr-undo'); if (b) b.click(); });
} catch(e) { console.warn('[imtr] GM_registerMenuCommand failed:', e); }

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'T') { e.preventDefault(); document.getElementById('imtr-fab')?.click(); }
  if (e.ctrlKey && e.shiftKey && e.key === 'R') { e.preventDefault(); INT.stop(); NR.remove(); }
});

})();