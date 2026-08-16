(function () {
  "use strict";

  const STORAGE_KEY = "bigcoach-luck-analyzer:v2";
  const PLAYER_NAME_KEY = "bigcoach-luck-player-name";
  const analyzer = window.LuckAnalyzer;
  let records = loadRecords();
  let selectedId = null;
  let scope = "all";

  const elements = {
    tabs: [...document.querySelectorAll(".tab")],
    panels: [...document.querySelectorAll(".tab-panel")],
    url: document.querySelector("#review-url"),
    fetch: document.querySelector("#fetch-button"),
    paste: document.querySelector("#paste-input"),
    pasteButton: document.querySelector("#paste-button"),
    file: document.querySelector("#file-input"),
    status: document.querySelector("#import-status"),
    bookmarklet: document.querySelector("#bookmarklet"),
    historyBookmarklet: document.querySelector("#history-bookmarklet"),
    historyPlayer: document.querySelector("#history-player"),
    demo: document.querySelector("#demo-button"),
    empty: document.querySelector("#empty-state"),
    metrics: document.querySelector("#metrics"),
    history: document.querySelector("#history-list"),
    export: document.querySelector("#export-button"),
    scopeSwitch: document.querySelector("#scope-switch"),
    scopeButtons: [...document.querySelectorAll("#scope-switch button")],
    trendSection: document.querySelector("#trend-section"),
    trendChart: document.querySelector("#trend-chart"),
    trendLegend: document.querySelector("#trend-legend")
  };

  const DEMO_DATA = {
    engine: "Mortal",
    game_length: "Hanchan",
    player_id: 0,
    review: {
      kyokus: [
        demoRound(0, 0.31, 0.07, false, false, 3900, 0),
        demoRound(1, 0.19, 0.12, true, true, 7600, 12000),
        demoRound(2, 0.43, 0.04, false, false, 5200, 0),
        demoRound(3, 0.27, 0.09, true, false, 8000, 0)
      ]
    }
  };

  function demoRound(kyoku, winP, riskP, riichi, win, expectedPoints, actualPoints) {
    const entries = [{
      junme: 1,
      actual: { type: "dahai", actor: 0, pai: "1z" },
      sl_outcome: [winP * 0.65, winP * 0.35, (1 - winP) * 0.34, (1 - winP) * 0.33, (1 - winP) * 0.33],
      details: [{ action: { type: "dahai", actor: 0, pai: "1z" }, houjuu_rate: riskP, expected_win_points: expectedPoints }]
    }];
    if (riichi) {
      entries.push({
        junme: 9,
        actual: { type: "reach", actor: 0 },
        sl_outcome: [winP * 0.65, winP * 0.35, (1 - winP) * 0.34, (1 - winP) * 0.33, (1 - winP) * 0.33],
        details: [{ action: { type: "reach", actor: 0 }, prob: 0.9 }]
      });
      entries.push({
        junme: 9,
        at_self_riichi: true,
        actual: { type: "dahai", actor: 0, pai: "5p" },
        sl_outcome: [winP * 0.65, winP * 0.35, (1 - winP) * 0.34, (1 - winP) * 0.33, (1 - winP) * 0.33],
        details: [{ action: { type: "dahai", actor: 0, pai: "5p" }, houjuu_rate: riskP, expected_win_points: expectedPoints }]
      });
    }
    return {
      kyoku,
      honba: 0,
      entries,
      end_status: win ? [{ type: "hora", actor: 0, target: 2, deltas: [actualPoints, 0, -actualPoints, 0], ura_markers: ["3p"] }] : [{ type: "ryukyoku", deltas: [0, 0, 0, 0] }]
    };
  }

  function loadRecords() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => item?.schemaVersion === analyzer.VERSION) : [];
    } catch {
      return [];
    }
  }

  function saveRecords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  function setStatus(message, type = "") {
    elements.status.className = `status${type ? ` is-${type}` : ""}`;
    elements.status.textContent = message;
  }

  function switchTab(name) {
    elements.tabs.forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    elements.panels.forEach((panel) => {
      const active = panel.dataset.panel === name;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
  }

  function addPayload(payload, meta = {}) {
    const record = analyzer.analyzePayload(payload, meta);
    const existing = records.findIndex((item) =>
      (record.gameId && item.gameId === record.gameId) || item.id === record.id
    );
    if (existing >= 0) {
      selectedId = records[existing].id;
      scope = "selected";
      setStatus("同じ対局はすでに保存済みのため、重複登録を除外しました。", "success");
    } else {
      records.unshift(record);
      selectedId = record.id;
      scope = "selected";
      setStatus(`${record.rounds.length}局を解析し、この端末に保存しました。`, "success");
    }
    saveRecords();
    render();
    document.querySelector("#dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function addBundle(bundle) {
    const incoming = Array.isArray(bundle?.items) ? bundle.items : [];
    if (!incoming.length) throw new Error("一括取得ファイルに解析可能な牌譜がありません。");
    const added = [];
    let duplicates = 0;
    let failed = 0;
    for (const item of incoming) {
      try {
        const record = analyzer.analyzePayload(item.data || item, {
          sourceUrl: item.sourceUrl || "",
          title: item.title || (item.taskId ? `BigCoach ${String(item.taskId).slice(0, 8)}` : "BigCoach解析"),
          importedAt: item.submittedAt || bundle.exportedAt,
          playerName: item.playerName || bundle.targetPlayer,
          platform: item.platform || "",
          table: item.table || ""
        });
        const exists = [...records, ...added].some((saved) =>
          (record.gameId && saved.gameId === record.gameId) || saved.id === record.id
        );
        if (exists) duplicates += 1;
        else added.push(record);
      } catch {
        failed += 1;
      }
    }
    records.unshift(...added);
    selectedId = null;
    scope = "all";
    saveRecords();
    render();
    const remoteFailures = Number(bundle?.failures?.length || 0);
    setStatus(`一括取込: ${added.length}対局を追加、${duplicates}件の重複を除外、${failed + remoteFailures}件を取得・解析できませんでした。`, added.length ? "success" : "error");
    document.querySelector("#dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function parseReviewUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("有効なレビューURLを入力してください。");
    }
    if (url.protocol !== "https:" || !["gokujan.com", "review.bigcoach.work"].includes(url.hostname)) {
      throw new Error("gokujan.com または review.bigcoach.work のHTTPS URLを入力してください。");
    }
    const match = url.pathname.match(/\/review\/([^/?#]+)/);
    if (!match) throw new Error("/review/ を含むBigCoachレビューURLではありません。");
    return { url, taskId: match[1] };
  }

  async function fetchFromReviewUrl(raw) {
    const { url, taskId } = parseReviewUrl(raw);
    const base = `${url.protocol}//${url.host}`;
    const resultResponse = await fetch(`${base}/api/v2/tasks/${encodeURIComponent(taskId)}/result`, { credentials: "omit" });
    if (!resultResponse.ok) throw new Error(`BigCoachが取得要求を拒否しました（HTTP ${resultResponse.status}）。`);
    const result = await resultResponse.json();
    if (!result?.success || !result?.data?.jsonUrl) throw new Error(result?.message || "解析JSONの場所を取得できませんでした。");
    const dataUrl = new URL(result.data.jsonUrl, base).href;
    const dataResponse = await fetch(dataUrl, { credentials: "omit" });
    if (!dataResponse.ok) throw new Error(`解析JSONを取得できませんでした（HTTP ${dataResponse.status}）。`);
    return dataResponse.json();
  }

  async function handleDirectFetch() {
    elements.fetch.disabled = true;
    setStatus("BigCoachからの直接取得を試しています…", "loading");
    try {
      const raw = elements.url.value.trim();
      const data = await fetchFromReviewUrl(raw);
      addPayload(data, { sourceUrl: raw, title: reviewTitle(raw) });
    } catch (error) {
      const reason = error instanceof TypeError
        ? "BigCoachへの直接接続がブラウザに拒否されました。"
        : error.message;
      setStatus(`${reason} 静的サイトではCORS制限があるため、ブックマークレットまたはJSON貼り付けをお使いください。`, "error");
      switchTab("paste");
    } finally {
      elements.fetch.disabled = false;
    }
  }

  function reviewTitle(url) {
    try {
      const taskId = new URL(url).pathname.match(/\/review\/([^/?#]+)/)?.[1];
      return taskId ? `BigCoach ${taskId.slice(0, 8)}` : "BigCoach解析";
    } catch {
      return "BigCoach解析";
    }
  }

  async function handleText(text, meta = {}) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("内容が空です。");
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (parsed?.kind === "bigcoach-luck-bundle") addBundle(parsed);
      else if (Array.isArray(parsed?.records)) addProcessedRecords(parsed.records);
      else addPayload(parsed, meta);
      return;
    }
    const extracted = analyzer.extractEmbeddedJson(trimmed);
    if (!extracted) throw new Error("HTML内に解析JSONを見つけられませんでした。ブックマークレットでJSONをコピーしてください。");
    if (extracted.dataUrl) {
      throw new Error("HTMLにはJSONのURLだけがありました。CORS制限を避けるため、ブックマークレットを実行してください。");
    }
    addPayload(extracted, meta);
  }

  function formatNumber(value, digits = 1) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
  }

  function signed(value, digits = 2) {
    if (!Number.isFinite(Number(value))) return "—";
    const numeric = Number(value);
    return `${numeric >= 0 ? "+" : "−"}${Math.abs(numeric).toFixed(digits)}`;
  }

  function addProcessedRecords(incoming) {
    const valid = incoming.filter((record) => record?.schemaVersion === analyzer.VERSION && Array.isArray(record.rounds));
    if (!valid.length) throw new Error("この履歴は旧計算方式です。元のBigCoach JSONから再取り込みしてください。");
    let added = 0;
    for (const record of valid) {
      const exists = records.some((saved) => (record.gameId && saved.gameId === record.gameId) || saved.id === record.id);
      if (!exists) {
        records.push(record);
        added += 1;
      }
    }
    saveRecords();
    scope = "all";
    selectedId = null;
    render();
    setStatus(`${added}対局の計算済み履歴を読み込みました。`, "success");
  }

  function luckLabel(score) {
    if (!Number.isFinite(Number(score))) return "データ不足";
    if (score >= 90) return "かなり上振れ";
    if (score >= 70) return "やや上振れ";
    if (score <= 10) return "かなり下振れ";
    if (score <= 30) return "やや下振れ";
    return "おおむね中央";
  }

  function setExperienceMetric(prefix, result, formatter) {
    const score = result.percentile;
    document.querySelector(`#${prefix}-percentile`).textContent = score == null ? "—" : formatNumber(score, 0);
    document.querySelector(`#${prefix}-meter`).style.width = `${score || 0}%`;
    document.querySelector(`#${prefix}-detail`).textContent = result.n
      ? `${luckLabel(score)} · ${formatter(result)} · 対象${result.n}局 / 経験分布${result.poolN}局${result.included ? "" : `（指数算入は${result.minimum}局から）`}`
      : "対象データがありません";
  }

  function setTheoryMetric(prefix, result, noun) {
    const score = result.percentile;
    document.querySelector(`#${prefix}-percentile`).textContent = score == null ? "—" : formatNumber(score, 0);
    document.querySelector(`#${prefix}-detail`).textContent = result.n
      ? `${luckLabel(score)} · 実績 ${formatNumber(result.observed, 0)} / 理論 ${formatNumber(result.expected, 2)} ${noun}（n=${result.n}）· 標準化差 ${signed(result.luckZ, 2)}`
      : "MJAIイベントから計算できる対象機会がありません";
    const position = score == null ? 50 : Math.max(4, Math.min(96, score));
    document.querySelector(`#${prefix}-marker`).style.left = `${position}%`;
  }

  function renderMetrics(summary) {
    const overall = summary.overall;
    document.querySelector("#overall-score").textContent = overall.score == null ? "—" : formatNumber(overall.score, 0);
    document.querySelector("#overall-label").textContent = overall.score == null
      ? "評価できる指標を蓄積中"
      : overall.score >= 90 ? "かなり運が良い"
        : overall.score >= 70 ? "やや運が良い"
          : overall.score <= 10 ? "かなり運が悪い"
            : overall.score <= 30 ? "やや運が悪い" : "おおむね標準的";
    document.querySelector("#overall-detail").textContent = overall.score == null
      ? "総合運に入れられる指標がまだありません。"
      : `${overall.included.length}/${overall.totalComponents}指標、${overall.families.filter((family) => family.included).length}系統を合成。これは記述指数であり、p値やσではありません。`;
    const overallComponents = document.querySelector("#overall-components");
    overallComponents.replaceChildren(
      ...overall.included.map((component) => overallChip(`${component.label} ${formatNumber(component.score, 0)}`, false)),
      ...overall.excluded.map((component) => overallChip(`${component.label}: ${component.reason}`, true))
    );
    setExperienceMetric("deal", summary.deal, (result) => `平均和了予測 ${formatNumber(result.value * 100, 1)}%`);
    setExperienceMetric("rank", summary.rankDeal, (result) => `平均順位ショック ${signed(result.value, 3)}`);
    setExperienceMetric("defense", summary.defense, (result) => `実績放銃 ${formatNumber(result.observed, 0)} / 予測合計 ${formatNumber(result.predicted, 2)}（${result.events}打牌）`);
    setTheoryMetric("dora", summary.dora, "回");
    setTheoryMetric("effective", summary.effective, "回");
    setTheoryMetric("riichi-win", summary.riichiWin, "回");
    setTheoryMetric("riichi-danger", summary.riichiDealIn, "回");
    setTheoryMetric("genbutsu", summary.genbutsu, "回");
    renderFairness(summary.fairness);
  }

  function overallChip(label, excluded) {
    const span = document.createElement("span");
    span.className = excluded ? "excluded" : "";
    span.textContent = label;
    return span;
  }

  function testRows(tests) {
    return tests.map((test) => {
      const row = document.createElement("tr");
      const adjusted = test.adjustedP;
      const verdict = adjusted == null ? "不足" : adjusted < 0.01 ? "要精査" : adjusted < 0.05 ? "注意" : "棄却せず";
      row.className = adjusted != null && adjusted < 0.05 ? "is-alert" : "";
      [test.label, test.method, test.n, test.pValue == null ? "—" : formatNumber(test.pValue, 4), adjusted == null ? "—" : formatNumber(adjusted, 4), verdict]
        .forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = String(value);
          row.append(cell);
        });
      return row;
    });
  }

  function renderFairness(fairness) {
    const groups = fairness?.groups || [];
    const diagnostics = fairness?.diagnostics || [];
    document.querySelector("#fairness-group-body").replaceChildren(...testRows(groups));
    document.querySelector("#fairness-body").replaceChildren(...testRows(diagnostics));
    const tested = groups.filter((test) => Number.isFinite(test.adjustedP));
    const alerts = tested.filter((test) => test.adjustedP < 0.05);
    const verdict = document.querySelector("#fairness-verdict");
    verdict.textContent = !tested.length ? "データ不足" : alerts.length ? `${alerts.length}件 要精査` : "有意な偏りなし";
    verdict.classList.toggle("is-alert", alerts.length > 0);
  }

  function svgElement(name, attributes = {}, text = "") {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    if (text) element.textContent = text;
    return element;
  }

  function renderTrend() {
    elements.trendSection.hidden = records.length === 0;
    elements.trendChart.replaceChildren();
    elements.trendLegend.replaceChildren();
    if (!records.length) return;

    const chronological = records
      .map((record, index) => ({ record, index, time: Date.parse(record.importedAt) || 0 }))
      .sort((left, right) => left.time - right.time || right.index - left.index)
      .map((item) => item.record);
    const pointCount = Math.min(24, chronological.length);
    const indices = [...new Set(Array.from({ length: pointCount }, (_, index) =>
      pointCount === 1 ? chronological.length - 1 : Math.round(index * (chronological.length - 1) / (pointCount - 1))
    ))];
    const points = indices.map((recordIndex) => {
      const summary = analyzer.summarize(chronological.slice(0, recordIndex + 1));
      return {
        recordIndex,
        date: chronological[recordIndex]?.importedAt,
        overall: summary.overall.score,
        ...Object.fromEntries(summary.overall.families.map((family) => [family.key, family.included ? family.score : null]))
      };
    });
    const series = [
      { key: "overall", label: "総合運", color: "#12614f", width: 4 },
      { key: "initial", label: "配牌", color: "#d98d3b", width: 2 },
      { key: "defense", label: "守備", color: "#b45145", width: 2 },
      { key: "draw", label: "通常ツモ", color: "#287cb5", width: 2 },
      { key: "riichi", label: "リーチ後", color: "#7656a8", width: 2 }
    ];
    for (const item of series) {
      const chip = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = item.color;
      chip.append(swatch, document.createTextNode(item.label));
      elements.trendLegend.append(chip);
    }

    const left = 48, right = 900, top = 18, bottom = 252;
    for (const value of [0, 25, 50, 75, 100]) {
      const y = bottom - (value / 100) * (bottom - top);
      elements.trendChart.append(
        svgElement("line", { x1: left, y1: y, x2: right, y2: y, class: value === 50 ? "trend-midline" : "trend-gridline" }),
        svgElement("text", { x: left - 9, y: y + 4, "text-anchor": "end", class: "trend-axis-label" }, String(value))
      );
    }
    const xFor = (index) => points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
    const yFor = (value) => bottom - Number(value) / 100 * (bottom - top);
    for (const item of series) {
      const valid = points.map((point, index) => ({ point, index, value: point[item.key] })).filter((entry) => Number.isFinite(entry.value));
      if (!valid.length) continue;
      const path = valid.map((entry, index) => `${index ? "L" : "M"}${xFor(entry.index).toFixed(1)},${yFor(entry.value).toFixed(1)}`).join(" ");
      elements.trendChart.append(svgElement("path", { d: path, fill: "none", stroke: item.color, "stroke-width": item.width, class: "trend-line" }));
      for (const entry of valid) {
        const circle = svgElement("circle", { cx: xFor(entry.index), cy: yFor(entry.value), r: item.key === "overall" ? 3.5 : 2.5, fill: item.color });
        const date = new Date(entry.point.date).toLocaleDateString("ja-JP");
        circle.append(svgElement("title", {}, `${date} · ${entry.point.recordIndex + 1}対局 · ${item.label} ${formatNumber(entry.value, 0)}`));
        elements.trendChart.append(circle);
      }
    }
    const first = points[0], last = points[points.length - 1];
    elements.trendChart.append(
      svgElement("text", { x: left, y: 282, "text-anchor": "start", class: "trend-axis-label" }, `${new Date(first.date).toLocaleDateString("ja-JP")} · ${first.recordIndex + 1}対局`),
      svgElement("text", { x: right, y: 282, "text-anchor": "end", class: "trend-axis-label" }, `${new Date(last.date).toLocaleDateString("ja-JP")} · ${last.recordIndex + 1}対局`)
    );
  }

  function gameLengthLabel(value) {
    const text = String(value || "").toLowerCase();
    if (text.includes("hanchan")) return "半荘";
    if (text.includes("tonpu") || text.includes("east")) return "東風戦";
    return value || "";
  }

  function renderHistory() {
    elements.history.replaceChildren();
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "取り込んだ牌譜は、ここに新しい順で保存されます。";
      elements.history.append(empty);
      return;
    }
    records.forEach((record) => {
      const fragment = document.querySelector("#history-template").content.cloneNode(true);
      const item = fragment.querySelector(".history-item");
      item.classList.toggle("is-selected", record.id === selectedId);
      fragment.querySelector(".history-date").textContent = new Date(record.importedAt).toLocaleDateString("ja-JP");
      fragment.querySelector(".history-title").textContent = record.title;
      const opponents = Array.isArray(record.opponents) && record.opponents.length
        ? `対戦: ${record.opponents.join("・")}`
        : "対戦相手情報なし";
      fragment.querySelector(".history-context").textContent = [record.platform, gameLengthLabel(record.gameLength), record.table, opponents].filter(Boolean).join(" · ");
      const summary = analyzer.summarize(records, record.id);
      fragment.querySelector(".history-meta").textContent = `${summary.rounds}局 · 総合 ${formatNumber(summary.overall.score, 0)} · 有効牌 ${formatNumber(summary.effective.percentile, 0)}`;
      fragment.querySelector(".history-main").addEventListener("click", () => {
        selectedId = record.id;
        scope = "selected";
        render();
        document.querySelector("#dashboard").scrollIntoView({ behavior: "smooth" });
      });
      fragment.querySelector(".delete-button").addEventListener("click", () => {
        if (!window.confirm(`「${record.title}」を端末から削除しますか？`)) return;
        records = records.filter((item) => item.id !== record.id);
        if (selectedId === record.id) selectedId = null;
        if (!selectedId) scope = "all";
        saveRecords();
        render();
      });
      elements.history.append(item);
    });
  }

  function render() {
    const allSummary = analyzer.summarize(records);
    const selectedExists = records.some((record) => record.id === selectedId);
    if (!selectedExists) selectedId = null;
    if (!selectedId) scope = "all";
    const summary = analyzer.summarize(records, scope === "selected" ? selectedId : null);
    document.querySelector("#hero-records").textContent = records.length;
    document.querySelector("#hero-rounds").textContent = allSummary.rounds;
    document.querySelector("#hero-pool").textContent = allSummary.theorySupportedRounds;
    elements.empty.hidden = records.length > 0;
    elements.metrics.hidden = records.length === 0;
    elements.export.disabled = records.length === 0;
    elements.scopeSwitch.hidden = !selectedId;
    elements.scopeButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.scope === scope));
    document.querySelector("#dashboard-title").textContent = scope === "selected"
      ? records.find((record) => record.id === selectedId)?.title || "牌譜サマリー"
      : "蓄積サマリー";
    if (records.length) renderMetrics(summary);
    renderTrend();
    renderHistory();
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify({ kind: "bigcoach-luck-records", version: analyzer.VERSION, exportedAt: new Date().toISOString(), records }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `bigcoach-luck-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function buildBookmarklet() {
    const code = `(async()=>{try{const m=location.pathname.match(/\\/review\\/([^/?#]+)/);if(!m)throw Error('BigCoachのレビュー画面で実行してください');const r=await fetch('/api/v2/tasks/'+encodeURIComponent(m[1])+'/result',{credentials:'include'}).then(x=>x.json());if(!r?.success||!r?.data?.jsonUrl)throw Error(r?.message||'JSON URLを取得できません');const d=await fetch(r.data.jsonUrl,{credentials:'include'}).then(x=>x.json());const t=JSON.stringify(d);try{await navigator.clipboard.writeText(t);alert('Luck Analyzer用JSONをコピーしました。解析サイトのJSON / HTML欄へ貼り付けてください。')}catch{const b=new Blob([t],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='bigcoach-'+m[1]+'.json';a.click();alert('JSONをダウンロードしました。解析サイトのファイル欄から選択してください。')}}catch(e){alert('取得できませんでした: '+e.message)}})()`;
    elements.bookmarklet.href = `javascript:${encodeURIComponent(code)}`;
    elements.bookmarklet.addEventListener("click", (event) => {
      if (location.protocol.startsWith("http")) {
        event.preventDefault();
        setStatus("このボタンはクリックではなく、ブックマークバーへドラッグして登録してください。", "loading");
      }
    });

    const updateHistoryBookmarklet = () => {
      const target = elements.historyPlayer.value.trim();
      localStorage.setItem(PLAYER_NAME_KEY, target);
      if (!target) {
        elements.historyBookmarklet.href = "#";
        elements.historyBookmarklet.textContent = "先にプレイヤー名を入力";
        elements.historyBookmarklet.setAttribute("aria-disabled", "true");
        return;
      }
      const historyCode = `(async()=>{let box;const target=__TARGET__,norm=x=>String(x??'').normalize('NFKC').trim().toLocaleLowerCase('ja-JP'),key='bigcoach-luck-sync:v2:'+norm(target);try{if(!location.pathname.startsWith('/account/history'))throw Error('BigCoachの履歴画面で実行してください');box=document.createElement('div');Object.assign(box.style,{position:'fixed',right:'18px',bottom:'18px',zIndex:2147483647,padding:'14px 18px',borderRadius:'10px',background:'#10201c',color:'#fff',font:'13px sans-serif',boxShadow:'0 8px 30px #0006'});box.textContent='Luck差分取得: 実戦履歴を確認中…';document.body.append(box);let state;try{state=JSON.parse(localStorage.getItem(key)||'{}')}catch{state={}}const done=state.done&&typeof state.done==='object'?state.done:{},save=()=>localStorage.setItem(key,JSON.stringify({target,updatedAt:new Date().toISOString(),done}));let rows=[],offset=0,total=1;while(offset<total){const res=await fetch('/api/v2/membership/history?limit=100&offset='+offset+'&category=real',{credentials:'include'});if(!res.ok)throw Error('履歴API HTTP '+res.status);const raw=await res.json(),page=raw?.success===false?null:(raw?.data||raw);if(!page)throw Error(raw?.error?.message||'履歴を取得できません');const batch=Array.isArray(page.items)?page.items:[];rows.push(...batch);total=Number(page.total??rows.length);if(!batch.length)break;offset+=batch.length;box.textContent='Luck差分取得: 実戦履歴 '+Math.min(offset,total)+' / '+total;}const unique=[...new Map(rows.filter(x=>x?.taskId).map(x=>[String(x.taskId),x])).values()],items=[],failures=[];for(const row of unique){const id=String(row.taskId);if(done[id])continue;if(row.reviewKind==='what_cut'){done[id]={status:'not-real',at:new Date().toISOString()};continue}if(norm(row.playerName)!==norm(target)){done[id]={status:'other-player',at:new Date().toISOString()};continue}box.textContent='Luck差分取得: 未取得JSON '+(items.length+failures.length+1)+'件目';try{const response=await fetch('/api/v2/tasks/'+encodeURIComponent(id)+'/result',{credentials:'include'});if(!response.ok)throw Error('HTTP '+response.status);const result=await response.json();if(!result?.success||!result?.data?.jsonUrl)throw Error(result?.message||'JSON URLなし');const dataResponse=await fetch(result.data.jsonUrl,{credentials:'include'});if(!dataResponse.ok)throw Error('JSON HTTP '+dataResponse.status);const data=await dataResponse.json(),platform=row.platform||row.sourcePlatform||row.gamePlatform||result.data?.paipuInfo?.platform||result.data?.platform||null,table=row.table||row.ruleName||result.data?.paipuInfo?.rule||null;items.push({taskId:id,sourceUrl:location.origin+'/review/'+id,title:[row.playerName,row.lastSubmittedAt?new Date(row.lastSubmittedAt).toLocaleDateString('ja-JP'):null,platform].filter(Boolean).join(' · ')||'BigCoach '+id.slice(0,8),playerName:row.playerName,submittedAt:row.lastSubmittedAt||null,platform,table,data});done[id]={status:'downloaded',at:new Date().toISOString()};save()}catch(e){failures.push({taskId:id,error:e.message})}}save();box.remove();if(!items.length){alert(target+'の未取得の実戦牌譜はありませんでした。'+(failures.length?' 再試行対象: '+failures.length+'件':''));return}const bundle={kind:'bigcoach-luck-bundle',version:2,mode:'incremental',targetPlayer:target,category:'real',exportedAt:new Date().toISOString(),source:location.href,items,failures};const blob=new Blob([JSON.stringify(bundle)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='bigcoach-luck-'+target.replace(/[\\/:*?"<>|]/g,'_')+'-diff-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);alert(target+'の未取得実戦牌譜 '+items.length+'件を保存しました。'+(failures.length?' 取得失敗 '+failures.length+'件は次回再試行します。':''));}catch(e){box?.remove();alert('差分取得できませんでした: '+e.message)}})()`
        .replace("__TARGET__", JSON.stringify(target));
      elements.historyBookmarklet.href = `javascript:${encodeURIComponent(historyCode)}`;
      elements.historyBookmarklet.textContent = `${target}の未取得実戦を保存`;
      elements.historyBookmarklet.removeAttribute("aria-disabled");
    };
    elements.historyPlayer.value = localStorage.getItem(PLAYER_NAME_KEY) || "";
    elements.historyPlayer.addEventListener("input", updateHistoryBookmarklet);
    updateHistoryBookmarklet();
    elements.historyBookmarklet.addEventListener("click", (event) => {
      if (location.protocol.startsWith("http")) {
        event.preventDefault();
        const target = elements.historyPlayer.value.trim();
        setStatus(target
          ? `「${target}の未取得実戦を保存」をブックマークバーへドラッグし、BigCoachの履歴画面で実行してください。`
          : "先にBigCoachのプレイヤー名を入力してください。", "loading");
      }
    });
  }

  elements.tabs.forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  elements.fetch.addEventListener("click", handleDirectFetch);
  elements.url.addEventListener("keydown", (event) => { if (event.key === "Enter") handleDirectFetch(); });
  elements.pasteButton.addEventListener("click", async () => {
    try {
      await handleText(elements.paste.value, { title: "貼り付けJSON" });
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
  elements.file.addEventListener("change", async () => {
    const file = elements.file.files?.[0];
    if (!file) return;
    try {
      await handleText(await file.text(), { title: file.name.replace(/\.(json|html?)$/i, "") });
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      elements.file.value = "";
    }
  });
  elements.demo.addEventListener("click", () => addPayload(DEMO_DATA, { title: "デモ牌譜" }));
  elements.export.addEventListener("click", downloadJson);
  elements.scopeButtons.forEach((button) => button.addEventListener("click", () => {
    scope = button.dataset.scope;
    render();
  }));

  buildBookmarklet();
  render();
})();
