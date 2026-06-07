// MedQA Worker v5.1 — + iso_crosscheck（ISO 對照/缺口紅旗）
// 既有：verification_plan + fishbone_to_doe + summarize_factors + identify_device
// 部署：Cloudflare Workers，ANTHROPIC_API_KEY 存於 Secret

const ALLOWED_ORIGINS = [
  'https://chiuchangru.github.io',
];

// 地理限制：只允許這些國家/地區（Cloudflare CF-IPCountry）
const ALLOWED_COUNTRIES = ['TW'];

// 模型分流政策 - 全部降低成本
const TOOL_MODEL_POLICY = {
  boxplot: 'haiku', scatter: 'haiku', histogram: 'haiku',
  spc: 'haiku', msa: 'haiku', doe: 'haiku',
  hypothesis: 'haiku', capa: 'haiku',
  pb: 'haiku',
  fishbone: 'sonnet',  // 魚骨圖用 sonnet
};
const MODEL_MAP = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-sonnet-4-6',  // opus 也導向 sonnet 省錢
};

// 每個工具的三問題模板
const TOOL_QUESTIONS = {

  // ── DOE：依設計類型自動對應 ──
  // statsText 前端會帶入設計類型關鍵字（全因子 / Fractional / Plackett-Burman）
  // 三個問題對全部設計通用，AI 根據 statsText 內容自行判斷
  doe: {
    q1: '數據品質與設計適切性：殘差常態性、重複次數是否足夠；若為部分因子請說明 Resolution 等級對結論的限制；若為 PB 設計請說明篩選用途與交互作用無法估計的限制',
    q2: '顯著因子判讀：哪些因子（主效應/交互作用）顯著、效應大小與方向；若為 Fractional 需提醒 Alias 混淆風險；若為 PB 建議帶入全因子確認',
    q3: '製程優化建議：依顯著因子給出參數調整方向；若數據不合理說明原因並建議重新試驗（包含是否需升級設計類型）',
  },

  scatter: {
    q1: '相關強度與方向（Pearson r、R²）、樣本數是否足夠',
    q2: '線性或非線性關係、是否有離群值影響相關性',
    q3: '相關不等於因果的提醒，以及後續驗證建議',
  },

  msa: {
    q1: '%GRR 可接受性判定（<10% 優良 / 10–30% 可接受 / >30% 不可接受）',
    q2: '變異來源分析：重複性 (EV) vs 再現性 (AV) 何者主導',
    q3: 'ndc 是否 ≥5、量測系統是否需改善及改善方向',
  },

  spc: {
    q1: '製程是否在管制內（Nelson 規則觸發情況）、數據穩定性評估',
    q2: '製程能力 Cp/Cpk 評估、是否滿足規格要求',
    q3: '製程改善建議或異常調查方向',
  },

  histogram: {
    q1: '常態性檢定結果（Shapiro-Wilk / Anderson-Darling）、分布形狀描述',
    q2: '偏態、峰態係數解讀、是否有離群值或雙峰現象',
    q3: '製程能力適用性與後續分析工具建議',
  },

  hypothesis: {
    q1: '檢定結果與 p 值判讀、前提假設（常態性、變異數齊一性）是否滿足',
    q2: '效應量（Cohen\'s d）大小、檢定力是否足夠、樣本數是否充足',
    q3: '統計結論與實務意義（統計顯著 ≠ 實務重要，需結合工程判斷）',
  },

  boxplot: {
    q1: '各組分布特徵：中位數、IQR、對稱性、是否有離群值',
    q2: '組間差異比較：位置（中位數）與離散程度（IQR）是否有明顯差異',
    q3: '是否需要進一步假設檢定（如 t-test / ANOVA）確認差異顯著性',
  },

  fishbone: {
    q1: '根本原因完整性：6M 各類別原因是否涵蓋、哪個類別原因最集中',
    q2: '最可能的關鍵根因（優先順序）：依原因數量與製程邏輯判斷',
    q3: '後續驗證建議：推薦使用哪些統計工具（DOE、假設檢定、SPC 等）進行確認',
  },

  pb: {
    q1: 'PB 設計適切性：實驗次數是否足夠、主效應估計可靠性、交互作用混淆的限制說明',
    q2: '顯著因子判讀：哪些因子效應顯著（依效應值大小與 Half-Normal Plot）、方向為正或負',
    q3: '後續建議：顯著因子是否足夠（2-4個）帶入全因子 DOE；若無顯著因子可能的原因',
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // 來源網域限制
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: '來源不允許' }), {
        status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }

    // 地理限制
    const country = request.headers.get('CF-IPCountry') || '';
    if (country && !ALLOWED_COUNTRIES.includes(country)) {
      return new Response(JSON.stringify({ error: '此服務僅限特定地區使用' }), {
        status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }

    try {
      // 次數限制：每 IP 每分鐘最多 20 次
      const RATE_LIMIT = 20;
      const RATE_WINDOW = 60;
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (env.RATE_KV) {
        try {
          const key = 'rl:' + clientIP;
          const cur = await env.RATE_KV.get(key);
          const count = cur ? parseInt(cur) : 0;
          if (count >= RATE_LIMIT) {
            return new Response(JSON.stringify({ error: '請求過於頻繁，請稍後再試（每分鐘上限 ' + RATE_LIMIT + ' 次）' }), {
              status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
            });
          }
          await env.RATE_KV.put(key, String(count + 1), { expirationTtl: RATE_WINDOW });
        } catch (e) { /* KV 失敗不阻擋正常請求 */ }
      }

      const body = await request.json();

      // 輸入長度限制
      const msgs = body.messages || [];
      const rawLen = JSON.stringify(msgs).length;
      if (rawLen > 30000) {
        return new Response(JSON.stringify({ error: '輸入過長（上限 30000 字元）' }), {
          status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }
      if (msgs.length > 30) {
        return new Response(JSON.stringify({ error: '對話過長（上限 30 則），請重新開始' }), {
          status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // 合法 mode 限制
      const mode = body.mode || 'chat';
      const VALID_MODES = ['navigate', 'analyze', 'chat', 'fishbone_generate', 'identify_device', 'summarize_factors', 'verification_plan', 'iso_crosscheck', 'stream_navigate', 'fishbone_to_doe', 'version'];
      if (!VALID_MODES.includes(mode)) {
        return new Response(JSON.stringify({ error: '無效的 mode' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // ══ version：回傳 Worker 版本 ══
      if (mode === 'version') {
        return json({ mode: 'version', version: 'v5.1' }, origin);
      }

      // ══ fishbone_to_doe：魚骨圖因子轉換為 DOE 實驗設計格式 ══
      if (mode === 'fishbone_to_doe') {
        const resp = await callClaude(env, MODEL_MAP.sonnet, {
          max_tokens: 800,
          system: `你是實驗設計（DOE）專家，將魚骨圖選出的可調變因子轉換成 DOE 實驗格式。
規則：
- 只處理可主動設定高低水準的連續因子（溫度、時間、壓力、濃度、速度等）
- 每個因子給出合理的低水準和高水準建議（根據製程常識）
- 單位要具體（°C、min、%、mm 等）
- 繁體中文`,
          tools: [{
            name: 'doe_factors',
            description: '轉換後的 DOE 因子清單',
            input_schema: {
              type: 'object',
              properties: {
                factors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      factor:   { type: 'string', description: '因子名稱' },
                      unit:     { type: 'string', description: '單位（°C/min/%/mm 等）' },
                      low:      { type: 'string', description: '低水準數值' },
                      high:     { type: 'string', description: '高水準數值' },
                      original: { type: 'string', description: '原始因子名稱' }
                    },
                    required: ['factor','unit','low','high','original']
                  }
                }
              },
              required: ['factors']
            }
          }],
          tool_choice: { type: 'tool', name: 'doe_factors' },
          messages: body.messages || []
        });
        const tu = resp.content && resp.content.find(c => c.type === 'tool_use');
        const factors = (tu && tu.input && tu.input.factors) || null;
        return json({ mode: 'fishbone_to_doe', factors }, origin);
      }

      // ══ stream_navigate：串流版 CAPA 對話 ══
      if (mode === 'stream_navigate') {
        const deviceContext = body.deviceInfo ? `
【已確認的醫療器材】
器材：${body.deviceInfo.confirmed_name}
材料：${body.deviceInfo.material}
結構：${body.deviceInfo.structure}
用途：${body.deviceInfo.indication}
關鍵品質特性：${(body.deviceInfo.key_quality||[]).join('、')}
絕對不能提及的失效原因：${(body.deviceInfo.cannot_be||[]).join('、')}
` : '';

        const surveyContext = body.surveyData ? `
【使用者問卷答案】
- 問題出現時機：${body.surveyData.timing || '未填'}
- 發現階段：${body.surveyData.stage || '未填'}
- 是否有量化數據：${body.surveyData.data || '未填'}
- 近期是否有變更：${body.surveyData.change || '未填'}
請根據以上問卷答案分析問題方向，只針對【不明確或矛盾】的地方追問。` : '';

        const streamResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'tools-2024-04-04',
          },
          body: JSON.stringify({
            model: MODEL_MAP.sonnet,
            max_tokens: 800,
            stream: true,
            system: `你是醫療器材品質工程師的 CAPA 引導助理，遵循 DMAIC 流程。
${deviceContext}
${surveyContext}

核心原則：
- DMAIC 的 D（Define）階段必須先用魚骨圖釐清根本原因
- 【魚骨圖永遠是第一個推薦工具】
- 根因未確認前，直接做統計分析方向可能錯誤
- 問診時必須根據已確認的器材特性，問出符合該器材的具體問題

問題判斷邏輯：
- 新產品一開始就有 → 設計問題方向（DOE、材料驗證）
- 以前OK最近才有 → 製程變異（SPC、假設檢定）
- 只有某些批次 → 材料/供應商差異（假設檢定、SPC）
- 只有某些人/機台 → 人員設備差異（MSA）

對話規則：
- 問題要問「現象」不問「原因」，避免使用專業術語
- 若使用者說「不知道」→ 換個角度問同一件事
- 有問卷資料時，最多再追問 1-3 輪；無問卷資料時，最多追問 5 輪
- 推薦時說明「為什麼用這個工具」（每個工具 20 字內）
- **推薦格式**：簡短說明後，最後一行必須是 [TOOLS: fishbone, tool2, ...]
- 回應總長度控制在 300 字以內

可推薦工具：fishbone, spc, msa, histogram, hypothesis, scatter, boxplot, pb
繁體中文，讓非統計背景的工程師也能理解`,
            messages: body.messages,
          })
        });

        // SSE 串流轉發
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
          const reader = streamResp.body.getReader();
          const decoder = new TextDecoder();
          let fullText = '';
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                    fullText += parsed.delta.text;
                    await writer.write(encoder.encode('data: ' + JSON.stringify({ text: parsed.delta.text }) + '\n\n'));
                  }
                  if (parsed.type === 'message_stop') {
                    // 提取工具推薦
                    const m = fullText.match(/\[TOOLS:\s*([^\]]+)\]/);
                    const tools = m ? m[1].split(',').map(t=>t.trim()).filter(Boolean) : [];
                    await writer.write(encoder.encode('data: ' + JSON.stringify({ done: true, fullText, tools }) + '\n\n'));
                  }
                } catch(e) {}
              }
            }
          } finally {
            await writer.close();
          }
        })();

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': corsHeaders(origin)['Access-Control-Allow-Origin'],
            'Access-Control-Allow-Headers': corsHeaders(origin)['Access-Control-Allow-Headers'],
          }
        });
      }

      // ══ verification_plan：為每個因子建議驗證計畫 ══
      if (mode === 'verification_plan') {
        const deviceCtx = body.deviceInfo ? `
【已確認器材】${body.deviceInfo.confirmed_name}
材料：${body.deviceInfo.material}
結構：${body.deviceInfo.structure}
關鍵品質：${(body.deviceInfo.key_quality||[]).join('、')}
` : '';

        const factors = body.factors || [];

        const resp = await callClaude(env, MODEL_MAP.sonnet, {  // 改用 sonnet 省成本
          max_tokens: 8000,
          system: `你是醫療器材 CAPA 驗證策略專家。為每個因子判斷該走哪種「驗證/矯正管道」，不要把所有因子都硬塞進統計實驗。
${deviceCtx}

【判斷順序（決策樹，依序判斷，命中即停）】
1. 製造商無法控制（病人狀態、臨床決策、臨床留置天數）→ pipeline=uncontrollable
2. 臨床使用/操作/人員手法/說明書 → pipeline=use_side（subtype：可用性人因62366 / IFU標示 / 教育訓練）
3. 「是否符合某 ISO 規範」的問題 → pipeline=compliance、iso_relevant=true（subtype：ISO規範符合性 / 生物相容10993 / 滅菌包裝確效 / 製程確效IQ-OQ-PQ / 品質系統13485）
4. 風險測不到或需證據 → pipeline=method_dev（量測方法開發 / 替代指標）或 pipeline=risk_evidence（風險管理14971 / 臨床評估14155 / 上市後監督PMS）
5. 供應商/來料品質 → pipeline=supplier
6. 可調變的設計/製程參數且量測可行 → pipeline=experiment（subtype：DOE / PB / 田口 / SPC / MSA / 假設檢定）

【鐵則】
- 不是每個因子都要 DOE/SPC/MSA。測不到的風險請走 method_dev / risk_evidence，不要硬給統計工具。
- 只有 compliance 類 iso_relevant=true，其餘一律 false。
- subtype 一律用上面括號內的詞。
- verification = 該管道下的具體建議動作（30字內，語氣符合管道：做實驗 / 查核ISO條文 / 開發量測法 / 訓練考核 / 修訂IFU / 列入風險檔 / 供應商稽核…）。
- link = 每個因子都要寫出它如何導致「使用者陳述的問題」的因果路徑（因子→中間機制→問題現象）。例：問題=「pigtail loop retention 不足」→「基材熱彈性記憶」link 寫「熱彈性記憶不足→定型後回彈→loop retention 下降」。與問題明顯無關的因子不要列。

繁體中文，務實、不學術`,

          tools: [{
            name: 'verification_plan',
            description: '為每個因子產生驗證計畫',
            input_schema: {
              type: 'object',
              properties: {
                plans: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      factor:       { type: 'string' },
                      risk:         { type: 'string', enum: ['high','medium','low'] },
                      pipeline:     { type: 'string', enum: ['experiment','compliance','method_dev','risk_evidence','use_side','supplier','uncontrollable'] },
                      subtype:      { type: 'string', description: '細項，如 DOE/SPC/MSA/假設檢定/ISO規範符合性/生物相容(10993)/滅菌包裝確效/製程確效IQ-OQ-PQ/品質系統(13485)/風險管理(14971)/臨床評估(14155)/上市後監督PMS/量測方法開發/替代指標/可用性人因(62366)/IFU標示/教育訓練/供應商管控/不可控' },
                      verification: { type: 'string', description: '建議動作（30字內）' },
                      link:         { type: 'string', description: '關聯鏈：此因子如何導致使用者陳述的問題（≤25字，「因子→中間機制→問題現象」）' },
                      iso_relevant: { type: 'boolean', description: '是否需對照ISO規範條文（僅compliance類true）' },
                      data_needed:  { type: 'string', enum: ['已有數據','需收集數據','需開發量測方法'] },
                      priority:     { type: 'number' }
                    },
                    required: ['factor','pipeline','verification']
                  }
                },
                summary: { type: 'string' }
              },
              required: ['plans','summary']
            }
          }],
          tool_choice: { type: 'tool', name: 'verification_plan' },
          messages: [{
            role: 'user',
            content: `問題：${body.problem || '未知'}\n\n需要驗證的因子：\n${factors.map(f => `- [${f.cat||''}] ${f.name}（風險：${f.risk}）`).join('\n')}\n\n請為每個因子設計驗證計畫。`
          }]
        });

        const tu = resp.content && resp.content.find(c => c.type === 'tool_use');
        const result = (tu && tu.input) || {};
        if(!Array.isArray(result.plans)) result.plans = [];
        const debugInfo = {
          stop_reason: resp.stop_reason,
          tool_fired: !!tu,
          n_plans: result.plans.length,
          n_factors: factors.length,
          content_types: (resp.content||[]).map(c=>c.type)
        };
        return json({ mode: 'verification_plan', result, _debug: debugInfo }, origin);
      }

      // ══ iso_crosscheck：ISO 對照 — 把因子/驗證計畫對照 ISO 應驗項目，標出缺口 ══
      // 重要：模型只能引用 body.isoStandards 內實際存在的標準與項目，嚴禁自行生成標準編號或條號。
      if (mode === 'iso_crosscheck') {
        const deviceCtx = body.deviceInfo ? `
【已確認器材】${body.deviceInfo.confirmed_name}
材料：${body.deviceInfo.material}
結構：${body.deviceInfo.structure}
用途：${body.deviceInfo.indication}
關鍵品質：${(body.deviceInfo.key_quality||[]).join('、')}` : '';

        const isoStandards = Array.isArray(body.isoStandards) ? body.isoStandards : [];
        const plans = Array.isArray(body.plans) ? body.plans : [];
        const factors = Array.isArray(body.factors) ? body.factors : [];

        // 把可引用的標準清單轉成精簡文字（編號/標題/適用關鍵詞/項目/已建檔章節）
        const stdText = isoStandards.map(s => {
          const items = (s.items||[]).map(i => i.k).join('、');
          const cls = (s.clauses||[]).map(c => `${c.no} ${c.title_zh||c.title_en||''}${c.verified===false?'(未核)':''}`).join('；');
          return `- ${s.no}${s.edition?(' ('+s.edition+')'):''}｜${s.title_zh||s.title}｜適用:${(s.applies_to||[]).join('/')}｜應驗項目:[${items}]｜已建檔章節:[${cls||'（無，章節待建檔）'}]`;
        }).join('\n');

        // 目前計畫已涵蓋的因子/驗證
        const planText = plans.length
          ? plans.map(p => `- 因子「${p.factor}」→ 驗證:${p.verification||''}（工具:${p.tool||''}）`).join('\n')
          : factors.map(f => `- 因子「${f.name||f}」`).join('\n');

        const resp = await callClaude(env, MODEL_MAP.sonnet, {
          max_tokens: 3500,
          system: `你是醫療器材法規/驗證稽核專家。任務：以「問題分析出來的因子」為主軸，逐因子對照對應的 ISO 規範與章節，判斷該因子相關的 ISO 要求有沒有在驗證計畫裡做確實。
${deviceCtx}

【核心原則 — 因子導向，不是攤標準全清單】
- 主軸是「使用者的問題因子」。針對每個因子，找出它對應到清單裡哪個標準的哪個應驗項目／章節。
- 不要把某標準的所有項目全列成缺口；只列「與本案因子相關」的。與因子無關的項目不要列。

【絕對規則 — 防止幻覺（最重要）】
1. 只能引用〈可引用標準清單〉裡實際存在的標準編號、項目與「已建檔章節」。
2. clause（章節）只能填該標準「已建檔章節」清單中列出的；**嚴禁自行發明、推測或補充任何章節號／Annex 代號**。
3. 若某標準的「已建檔章節」為空或找不到對應章節 → clause 一律填「（章節待建檔）」。標「(未核)」的章節仍可引用，但要在 note 提醒「章節待核可」。
4. 不要捏造允收數值或準則；項目為類別草稿。

【判讀每個因子】
- standard：該因子對應的標準編號（取自清單）。
- clause：對應章節（取自該標準已建檔章節；沒有就「（章節待建檔）」）。
- item：對應的應驗項目（取自清單）。
- status：covered＝計畫已明確涵蓋；partial＝有相關因子但驗證不完整；gap＝ISO 應驗但計畫沒涵蓋（CAPA 風險）。
- covered_by：對應的因子/驗證名稱；note：20字內提醒（如「以正本最新版次為準」）。

【特別注意 — 別把「材料間相容/接合」誤判成生物相容】
- 「黏合、溶脹、接合強度」等屬接合完整性/材料工程 → 對應導管本體標準（如 ISO 10555-1 的接頭/拉伸條款），不是 ISO 10993。
- ISO 10993 只在「材料對人體/血液的生物安全（細胞毒性/致敏/血液相容/化學溶出）」時才引用。

繁體中文，務實，不要學術長文。`,
          tools: [{
            name: 'iso_crosscheck',
            description: 'ISO 應驗項目與驗證計畫的覆蓋比對，標出缺口',
            input_schema: {
              type: 'object',
              properties: {
                applicable: {
                  type: 'array',
                  description: '判定適用於本器材的標準（只能取自清單）',
                  items: { type: 'object', properties: {
                    no: { type: 'string' },
                    reason: { type: 'string', description: '為何適用，15字內' }
                  }, required: ['no'] }
                },
                items: {
                  type: 'array',
                  description: '逐因子對照：每個問題因子對應的 ISO 標準+章節+覆蓋判讀',
                  items: { type: 'object', properties: {
                    factor:     { type: 'string', description: '對應的問題因子名稱' },
                    standard:   { type: 'string', description: '標準編號（取自清單）' },
                    clause:     { type: 'string', description: '對應章節（僅取自該標準「已建檔章節」；無則填「（章節待建檔）」，嚴禁自創）' },
                    item:       { type: 'string', description: '應驗項目（取自清單）' },
                    status:     { type: 'string', enum: ['covered','partial','gap'] },
                    covered_by: { type: 'string', description: '對應因子/驗證名稱；gap 留空' },
                    note:       { type: 'string', description: '20字內提醒' }
                  }, required: ['standard','status'] }
                },
                summary: { type: 'string', description: '缺口總結與建議，50字內' }
              },
              required: ['items']
            }
          }],
          tool_choice: { type: 'tool', name: 'iso_crosscheck' },
          messages: [{
            role: 'user',
            content: `問題：${body.problem || '未知'}

〈可引用標準清單〉（只能引用這些；clause 只能取自各標準的「已建檔章節」）：
${stdText || '(無，請回傳空結果)'}

〈問題分析出來的因子與驗證計畫〉：
${planText || '(無)'}

請以「每個因子」為主軸：找出該因子對應的標準與章節（clause 只填已建檔章節，沒有就「（章節待建檔）」），判讀 covered/partial/gap。只列與因子相關的，不要攤標準全清單。`
          }]
        });

        const tu = resp.content && resp.content.find(c => c.type === 'tool_use');
        const result = (tu && tu.input) || {};
        if(!Array.isArray(result.items)) result.items = [];
        if(!Array.isArray(result.applicable)) result.applicable = [];
        const debugInfo = {
          stop_reason: resp.stop_reason,
          tool_fired: !!tu,
          n_applicable: result.applicable.length,
          n_items: result.items.length,
          content_types: (resp.content||[]).map(c=>c.type)
        };
        return json({ mode: 'iso_crosscheck', result, _debug: debugInfo }, origin);
      }

      // ══ summarize_factors：整理因子清單供使用者確認 ══
      if (mode === 'summarize_factors') {
        const deviceCtx = body.deviceInfo ? `
【已確認器材】${body.deviceInfo.confirmed_name}
材料：${body.deviceInfo.material}
結構：${body.deviceInfo.structure}
關鍵品質：${(body.deviceInfo.key_quality||[]).join('、')}
絕對不能列的因子：${(body.deviceInfo.cannot_be||[]).join('、')}
` : '';

        const factorItem = {
          type: 'object',
          properties: {
            name:        { type: 'string', description: '因子名稱（10字以內）' },
            risk:        { type: 'string', enum: ['high','medium','low'] },
            basis:       { type: 'string', description: '依據來源（20字內）' },
            tool:        { type: 'string', enum: ['doe','pb','taguchi','spc','msa','hypothesis','none'],
                           description: '建議分析工具' },
            tool_reason: { type: 'string', description: '為何用這個工具（15字內）' },
            link:        { type: 'string', description: '關聯鏈：此因子如何導致使用者陳述的問題（≤25字，格式「因子→中間機制→問題現象」）' },
            speculative: { type: 'boolean', description: '若無法說出與本問題的明確因果關聯，設為 true（前端會標「推測*」）' }
          },
          required: ['name','risk','basis','tool','tool_reason']
        };

        const resp = await callClaude(env, MODEL_MAP.sonnet, {  // 改用 sonnet 省成本
          max_tokens: 2000,
          system: `你是醫療器材品質專家，根據對話內容整理魚骨圖 6M 因子清單，並為每個因子指定最適合的分析工具。
${deviceCtx}

【工具選擇規則 - 必須嚴格遵守】

判斷步驟：先看因子「能不能主動設定數值」，能的話才考慮 doe/pb/taguchi。

- doe：因子是**可主動設定高低水準的連續參數**
  → 溫度、時間、壓力、速度、濃度、角度、厚度、尺寸、比例
  → 即使名稱含「控制」「設定」「調整」也算 doe
  → 例：「烘烤溫度控制」=doe、「固化時間設定」=doe、「塗布速度」=doe

- pb：因子數量 ≥ 5 個且都是可調變參數 → 先用 pb 篩選，再 doe

- taguchi：因子是**環境雜訊**（使用者無法控制）
  → 環境溫濕度、操作者個體差異、材料批次間差異（不可控部分）

- spc：因子描述的是**被動發生的現象或設備狀態**
  → 設備老化、磨損、漂移、偏移、不穩定
  → 「老化」「磨損」「漂移」「衰退」是 spc
  → 注意：「溫度控制」是 doe，「溫度漂移/不穩定」才是 spc

- msa：因子描述**量測或判定方法的差異**
  → 量具精度、操作者判定標準、量測重複性
  → 「操作手法」如果指的是量測/判定 → msa
  → 「操作手法」如果指的是製程操作 → spc 或 doe

- hypothesis：因子是**不同群組之間的比較**
  → 批次A vs 批次B、供應商X vs 供應商Y

- none：環境類受 ISO 規範管控

【常見錯誤禁止】
- 設備老化/磨損 → 絕對不是 doe，是 spc
- 「溫度控制」「時間設定」「壓力調整」→ 絕對是 doe，不是 spc
- 操作者技能/手法 → 判斷是製程操作（spc）還是量測判定（msa）
- 因子數 > 5 且都可調 → 優先 pb

規則：
- 每個因子必須有依據，不可捏造
- 每個類別 3-5 個
- 沒有依據的類別回傳空陣列
- 繁體中文

【關聯性 — 必填，這很重要】
- 先讀懂使用者陳述的「問題現象」。每個因子都要能連回那個現象，並在 link 欄寫出因果路徑（因子→中間機制→問題現象）。
  例：問題=「透析有效流量下降」→「擠出機螺桿磨損」的 link 應寫「螺桿磨損→押出內徑變異→有效流量下降」。
- 若某因子寫不出對應「本問題」的因果路徑，仍可列出，但必須設 speculative:true（誠實標記為推測），不要硬湊一條牽強的關聯。
- 寧可標 speculative，也不要編造關聯。與本問題明顯無關的因子直接不要列。`,
          tools: [{
            name: 'factor_summary',
            description: '整理 6M 因子清單，每個因子含建議工具',
            input_schema: {
              type: 'object',
              properties: {
                man:      { type: 'array', items: factorItem },
                machine:  { type: 'array', items: factorItem },
                material: { type: 'array', items: factorItem },
                method:   { type: 'array', items: factorItem },
                measure:  { type: 'array', items: factorItem },
                env:      { type: 'array', items: factorItem },
                summary:  { type: 'string', description: '整體分析摘要（50字內）' }
              },
              required: ['man','machine','material','method','measure','env','summary']
            }
          }],
          tool_choice: { type: 'tool', name: 'factor_summary' },
          messages: body.messages
        });
        const tu = resp.content && resp.content.find(c => c.type === 'tool_use');
        const result = (tu && tu.input) || null;
        return json({ mode: 'summarize_factors', result }, origin);
      }

      // ══ identify_device：醫療器材識別 ══
      if (mode === 'identify_device') {
        const deviceName = body.deviceName || '';
        const deviceNameEn = body.deviceNameEn || deviceName;
        const fdaData = body.fdaData || '';

        const resp = await callClaude(env, MODEL_MAP.sonnet, {
          max_tokens: 600,
          system: `你是醫療器材專家，根據器材名稱和 FDA 資料庫資訊，識別並說明這個醫療器材。
必須呼叫 device_info 工具輸出結構化資訊。
務必依固定字彙填寫 category_keys（本器材屬於哪些類別），這會決定後續 ISO 對照要拿哪些標準來比——分類錯會掛錯標準，請謹慎、寧缺勿濫。
用繁體中文填寫（英文術語保留英文），資訊要精確、實用。`,
          tools: [{
            name: 'device_info',
            description: '醫療器材識別結果',
            input_schema: {
              type: 'object',
              properties: {
                confirmed_name: { type: 'string', description: '確認的器材中文名稱（含英文）' },
                device_class: { type: 'string', description: 'FDA Class I/II/III' },
                material: { type: 'string', description: '主要材料（具體，如：316L不銹鋼、PEBAX、聚氨酯）' },
                structure: { type: 'string', description: '結構描述（50字內）' },
                indication: { type: 'string', description: '適應症/用途（30字內）' },
                key_quality: { type: 'array', items: { type: 'string' }, description: '關鍵品質特性（3-5項，如：硬度、親水性、密封性）' },
                category_keys: { type: 'array', items: { type: 'string', enum: ['intravascular','central-venous','dialysis','extracorporeal','bloodline','HD','balloon','introducer','sheath','guidewire','needle','guide','ureteral','stent','connector','luer','tubing','tracheal','tracheostomy','airway','suction','respiratory','anaesthetic','infusion','iv','iv-bag','container','biliary','drainage','urine-bag','other'] }, description: '器材分類關鍵詞（從清單擇一或多選，供 ISO 對照做確定性過濾）。血管內導管=intravascular（中心靜脈+central-venous、血液透析導管+dialysis、球囊+balloon）；血液回路管/體外循環=extracorporeal+bloodline+dialysis；導引器/鞘=introducer/sheath；導絲=guidewire；皮下/切片針=needle；同軸導引針=needle+guide；輸尿管支架=ureteral+stent；魯爾接頭=connector/luer；不鏽鋼針管=tubing；氣管內管=tracheal+airway+respiratory；氣切管=tracheostomy+airway+respiratory；抽痰管=suction+respiratory；麻醉/氧氣面罩=respiratory+anaesthetic；輸液套=infusion+iv；IV軟袋=iv-bag+container+infusion；膽道/鼻膽=biliary；引流管/袋=drainage；尿袋=urine-bag；都不符=other。寧可少給也不要硬塞不相關類別。' },
                cannot_be: { type: 'array', items: { type: 'string' }, description: '不可能的失效原因（2-4項，用於排除錯誤的魚骨圖因子）' },
                confidence: { type: 'number', description: '識別信心度 0-100' }
              },
              required: ['confirmed_name','material','structure','indication','key_quality','cannot_be','confidence']
            }
          }],
          tool_choice: { type: 'tool', name: 'device_info' },
          messages: [{
            role: 'user',
            content: `器材中文名稱：${deviceName}\n器材英文名稱：${deviceNameEn}\n\nFDA 510k 資料庫資訊：\n${fdaData || '(無 FDA 資料，請根據器材名稱推斷)'}\n\n請識別這個醫療器材並填入詳細資訊。`
          }]
        });

        const tu = resp.content && resp.content.find(c => c.type === 'tool_use');
        const result = (tu && tu.input) || null;
        // 回傳 debug 資訊幫助診斷
        return json({
          mode: 'identify_device',
          result,
          _debug: result ? null : {
            stop_reason: resp.stop_reason,
            content_types: (resp.content||[]).map(c=>c.type),
            api_error: resp.error
          }
        }, origin);
      }

      // 決定使用的模型
      const toolId = body.toolId || 'capa';
      const modelTier = TOOL_MODEL_POLICY[toolId] || 'sonnet';
      const model = MODEL_MAP[modelTier];

      // ══ navigate：CAPA 導航助理 ══
      if (mode === 'navigate') {
        // 器材知識 context
        const deviceContext = body.deviceInfo ? `
【已確認的醫療器材】
器材：${body.deviceInfo.confirmed_name}
材料：${body.deviceInfo.material}
結構：${body.deviceInfo.structure}
用途：${body.deviceInfo.indication}
關鍵品質特性：${(body.deviceInfo.key_quality||[]).join('、')}
絕對不能提及的失效原因：${(body.deviceInfo.cannot_be||[]).join('、')}
` : '';

        // 問卷 context
        const surveyContext = body.surveyData ? `
【使用者問卷答案】
- 問題出現時機：${body.surveyData.timing || '未填'}
- 發現階段：${body.surveyData.stage || '未填'}
- 是否有量化數據：${body.surveyData.data || '未填'}
- 近期是否有變更：${body.surveyData.change || '未填'}
請根據以上問卷答案分析問題方向，只針對【不明確或矛盾】的地方追問。` : '';

        const resp = await callClaude(env, MODEL_MAP.sonnet, {
          max_tokens: 800,
          system: `你是醫療器材品質工程師的 CAPA 引導助理，遵循 DMAIC 流程。
${deviceContext}
${surveyContext}

核心原則：
- DMAIC 的 D（Define）階段必須先用魚骨圖釐清根本原因
- 【魚骨圖永遠是第一個推薦工具】
- 根因未確認前，直接做統計分析方向可能錯誤
- 問診時必須根據已確認的器材特性，問出符合該器材的具體問題

問題判斷邏輯（根據問卷答案）：
- 新產品一開始就有 → 設計問題方向（DOE、材料驗證）
- 以前OK最近才有 → 製程變異（SPC、假設檢定）
- 只有某些批次 → 材料/供應商差異（假設檢定、SPC）
- 只有某些人/機台 → 人員設備差異（MSA）
- 有近期變更 → 變更管理，對照組比較（假設檢定）

對話規則：
- 問題要問「現象」不問「原因」，避免使用專業術語
- 若使用者說「不知道」→ 換個角度問同一件事
- 有問卷資料時，最多再追問 1-3 輪；無問卷資料時，最多追問 5 輪
- 推薦時說明「為什麼用這個工具」（每個工具 20 字內）
- **推薦格式**：簡短說明後，最後一行必須是 [TOOLS: fishbone, tool2, ...]
- 回應總長度控制在 300 字以內

可推薦工具：fishbone, spc, msa, histogram, hypothesis, scatter, boxplot, pb
繁體中文，讓非統計背景的工程師也能理解`,
          messages: body.messages,
        });
        const text = (resp.content && resp.content[0] && resp.content[0].text) || '';
        const m = text.match(/\[TOOLS:\s*([^\]]+)\]/);
        let tools = m ? m[1].split(',').map(t => t.trim()).filter(Boolean) : [];
        // 保險：推薦清單有工具時，魚骨圖永遠排第一
        if (tools.length > 0 && !tools.includes('fishbone')) {
          tools = ['fishbone', ...tools];
        } else if (tools.length > 0 && tools[0] !== 'fishbone') {
          tools = ['fishbone', ...tools.filter(t => t !== 'fishbone')];
        }
        const clean = text.replace(/\[TOOLS:[^\]]+\]/, '').trim();
        return json({ mode: 'navigate', text: clean, tools, done: tools.length > 0 }, origin);
      }

      // ══ fishbone_generate：魚骨圖 6M 建議生成（模型可選）══
      if (mode === 'fishbone_generate') {
        // 使用者可選模型：sonnet（省 token）或 opus（品質較高）
        const fbModel = (body.fbModel === 'opus') ? MODEL_MAP.opus : MODEL_MAP.sonnet;  // 預設 sonnet
        const deviceCtx = body.deviceInfo ? `
【已確認器材】${body.deviceInfo.confirmed_name}
材料：${body.deviceInfo.material}
結構：${body.deviceInfo.structure}
關鍵品質：${(body.deviceInfo.key_quality||[]).join('、')}
絕對不能列的因子：${(body.deviceInfo.cannot_be||[]).join('、')}
` : '';
        const resp = await callClaude(env, fbModel, {
          max_tokens: 2000,
          system: `你是醫療器材製程與設計品質專家，擅長根本原因分析（RCA）。
${deviceCtx}
【醫療器材常識 - 必須遵守】
- 注射針、採血針、檢體針的針管：100% 不銹鋼（304/316L），材質固定，硬度不是變因
- 針管表面：出廠前已電解拋光，表面粗糙度是規格項目不是製程變因
- 塑膠件（hub、座體）：PC/ABS/PP，射出成型
- 親水塗層：導管類才有，針頭通常無
- 密封件：橡膠/TPE，有批次差異

【分析規則】
1. 根據問題類型聚焦：
   - 設計階段 → 著重設計參數、規格定義、幾何尺寸
   - 製程問題 → 著重製程參數、設備、操作條件
   - 客戶端 → 著重量測方法、使用條件
2. 對話/問卷已排除的方向 → 回傳空陣列 []
3. 沒有依據的類別 → 回傳空陣列 []
4. 嚴禁列出違反材料常識的原因（如「針管硬度不足」「針管表面粗糙」）
5. 每個類別 3-5 個原因，具體貼近實際製程，10字以內
6. 風險等級：high（直接影響功能安全）/ medium（影響穩定性）/ low（間接影響）
7. 繁體中文`,
          tools: [{
            name: 'fishbone_causes',
            description: '輸出魚骨圖 6M 根本原因建議，已排除的類別回傳空陣列 []',
            input_schema: {
              type: 'object',
              properties: {
                man:      { type: 'array', description: '人員 Man（若已排除回傳 []）', items: { type: 'object', properties: { name: { type: 'string' }, risk: { type: 'string', enum: ['high','medium','low'] } }, required: ['name','risk'] } },
                machine:  { type: 'array', description: '機器 Machine（若已排除回傳 []）', items: { type: 'object', properties: { name: { type: 'string' }, risk: { type: 'string', enum: ['high','medium','low'] } }, required: ['name','risk'] } },
                material: { type: 'array', description: '材料 Material', items: { type: 'object', properties: { name: { type: 'string' }, risk: { type: 'string', enum: ['high','medium','low'] } }, required: ['name','risk'] } },
                method:   { type: 'array', description: '方法 Method', items: { type: 'object', properties: { name: { type: 'string' }, risk: { type: 'string', enum: ['high','medium','low'] } }, required: ['name','risk'] } },
                measure:  { type: 'array', description: '量測 Measurement', items: { type: 'object', properties: { name: { type: 'string' }, risk: { type: 'string', enum: ['high','medium','low'] } }, required: ['name','risk'] } },
                env:      { type: 'array', description: '環境 Environment', items: { type: 'object', properties: { name: { type: 'string' }, risk: { type: 'string', enum: ['high','medium','low'] } }, required: ['name','risk'] } },
              },
              required: ['man', 'machine', 'material', 'method', 'measure', 'env'],
            },
          }],
          tool_choice: { type: 'tool', name: 'fishbone_causes' },
          messages: body.messages,
        });
        const tu = resp.content && resp.content.find(c => c.type === 'tool_use');
        const result = (tu && tu.input) || null;
        // 若 result 為 null，回傳詳細錯誤
        if (!result) {
          const errDetail = resp.error ? JSON.stringify(resp.error) :
            (resp.content ? resp.content.map(c=>c.type+':'+(c.text||'').slice(0,100)).join('|') : 'empty response');
          return json({ mode: 'fishbone_generate', result: null, error: errDetail }, origin);
        }
        return json({ mode: 'fishbone_generate', result }, origin);
      }

      // ══ analyze：工具分流三問題判讀 ══
      if (mode === 'analyze') {
        const q = TOOL_QUESTIONS[toolId] || TOOL_QUESTIONS.spc;
        const resp = await callClaude(env, model, {
          max_tokens: 1000,
          system: `你是醫療器材品質工程師的統計分析助理。
根據提供的統計數據，必須呼叫 report_analysis 工具填入三個問題判讀。
每欄 100 字以內，繁體中文，只說統計判讀，不引用 ISO 條文編號。
若為 DOE 分析，請根據 statsText 中的設計類型（全因子/部分因子/Plackett-Burman）給出對應的判讀重點。`,
          tools: [{
            name: 'report_analysis',
            description: '輸出統計分析三問題結構化判讀',
            input_schema: {
              type: 'object',
              properties: {
                q1: { type: 'string', description: q.q1 },
                q2: { type: 'string', description: q.q2 },
                q3: { type: 'string', description: q.q3 },
              },
              required: ['q1', 'q2', 'q3'],
            },
          }],
          tool_choice: { type: 'tool', name: 'report_analysis' },
          messages: body.messages,
        });
        const tu = resp.content && resp.content.find(c => c.type === 'tool_use');
        const result = (tu && tu.input) || { q1: '無法判讀，請重試', q2: '無法判讀，請重試', q3: '無法判讀，請重試' };
        return json({ mode: 'analyze', toolId, labels: q, result }, origin);
      }

      // ══ chat：自由對話（追問）══
      const resp = await callClaude(env, model, {
        max_tokens: 600,
        system: body.system || '你是醫療器材品質工程師的 AI 助理。繁體中文，簡潔專業，不超過 200 字。',
        messages: body.messages,
      });
      return json(resp, origin);

    } catch (err) {
      return new Response(JSON.stringify({ error: '伺服器處理失敗，請稍後再試' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }
  }
};

async function callClaude(env, model, payload) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024-04-04',
    },
    body: JSON.stringify({ model, ...payload }),
  });
  return await r.json();
}

function json(obj, origin) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
