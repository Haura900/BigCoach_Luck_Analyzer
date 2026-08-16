(function () {
  "use strict";

  const STORAGE_KEY = "bigcoach-luck-analyzer:v2";
  const PLAYER_NAME_KEY = "bigcoach-luck-player-name";
  const DATABASE_NAME = "bigcoach-luck-analyzer";
  const DATABASE_VERSION = 2;
  const RECORD_STORE = "records";
  const CACHE_STORE = "analysis-cache";
  const CACHE_VERSION = 9;
  const analyzer = window.LuckAnalyzer;
  let records = [];
  let databasePromise = null;
  const summaryCache = new Map();
  let selectedId = null;
  let scope = "all";
  let trendLimit = "50";
  const trendVisible = new Set(["actualRankPlot", "overall"]);
  let trendSelectionInitialized = false;
  const METRIC_LABELS = {
    deal: "配牌時和了率",
    rankDeal: "配牌時平着変動",
    defense: "放銃予実幅",
    dora: "ドラツモ率",
    effective: "有効牌ツモ率",
    effective2: "2シャンテン時有効牌",
    effective1: "1シャンテン時有効牌",
    genbutsu1: "被リーチ・1シャンテン時現物",
    genbutsuTenpai: "被リーチ・聴牌時現物",
    fuuroGenbutsu: "被副露時現物",
    fuuroGenbutsu1: "被副露・1シャンテン時現物",
    fuuroGenbutsuTenpai: "被副露・聴牌時現物",
    wasteDraw: "無駄ツモ回避度",
    riichiWin: "リーチ時自明和了率",
    riichiDealIn: "リーチ後危険牌回避度",
    genbutsu: "被リーチ時現物掴み率",
    riichiHitOpponent: "リーチ時他家掴ませ率",
    uraSelf: "自分裏ドラ運",
    opponentDora: "他家ドラツモ回避",
    opponentRiichiWin: "他家リーチ和了回避",
    uraOpponent: "他家裏ドラ回避",
    selfTenpaiWin: "テンパイ後和了牌ツモ",
    opponentTenpaiWin: "他家和了牌ツモ回避",
    selfTenpaiEntry: "テンパイ到達ツモ",
    opponentTenpaiEntry: "他家テンパイ到達回避",
    initialDoraSelf: "配牌時ドラ枚数",
    initialYakuhai: "配牌時役牌対子・暗刻",
    initialDoraOpponent: "他家配牌ドラ回避",
    otherWinAvoidLuck: "他家決着回避上振れ"
  };

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
    dashboardControls: document.querySelector("#dashboard-controls"),
    scopeSwitch: document.querySelector("#scope-switch"),
    scopeButtons: [...document.querySelectorAll("#scope-switch button")],
    recordSelect: document.querySelector("#record-select"),
    trendSection: document.querySelector("#trend-section"),
    trendChart: document.querySelector("#trend-chart"),
    trendLegend: document.querySelector("#trend-legend"),
    trendLimit: document.querySelector("#trend-limit")
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

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RECORD_STORE)) database.createObjectStore(RECORD_STORE, { keyPath: "id" });
        if (!database.objectStoreNames.contains(CACHE_STORE)) database.createObjectStore(CACHE_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDBを開けませんでした。"));
    });
    return databasePromise;
  }

  function compactEvents(events) {
    return (events || []).map((event) => {
      const compact = { p: Number(event.p), y: Number(event.y) };
      if (Number.isFinite(Number(event.v))) compact.v = Number(event.v);
      return compact;
    });
  }

  function compactRecord(record) {
    return {
      schemaVersion: record.schemaVersion,
      calculationVersion: Number(record.calculationVersion || 0),
      id: record.id,
      gameId: record.gameId,
      taskId: String(record.taskId || ""),
      title: record.title,
      importedAt: record.importedAt,
      gameLength: record.gameLength || "",
      platform: record.platform || "",
      table: record.table || "",
      opponents: Array.isArray(record.opponents) ? record.opponents.slice(0, 3) : [],
      actualRank: record.actualRank != null && Number.isInteger(Number(record.actualRank)) && Number(record.actualRank) >= 1 && Number(record.actualRank) <= 4 ? Number(record.actualRank) : null,
      finalScore: record.finalScore != null && Number.isFinite(Number(record.finalScore)) ? Number(record.finalScore) : null,
      rounds: (record.rounds || []).map((round) => ({
        label: String(round.label || ""),
        index: round.index != null && Number.isInteger(Number(round.index)) ? Number(round.index) : null,
        seat: round.seat,
        deal: round.deal ? { value: Number(round.deal.value) } : null,
        rankDeal: round.rankDeal ? { value: Number(round.rankDeal.value) } : null,
        defense: compactEvents(round.defense),
        dora: compactEvents(round.dora),
        effective: compactEvents(round.effective),
        effective2: compactEvents(round.effective2),
        effective1: compactEvents(round.effective1),
        genbutsu: compactEvents(round.genbutsu),
        genbutsu1: compactEvents(round.genbutsu1),
        genbutsuTenpai: compactEvents(round.genbutsuTenpai),
        fuuroGenbutsu: compactEvents(round.fuuroGenbutsu),
        fuuroGenbutsu1: compactEvents(round.fuuroGenbutsu1),
        fuuroGenbutsuTenpai: compactEvents(round.fuuroGenbutsuTenpai),
        wasteDraw: compactEvents(round.wasteDraw),
        riichiWin: compactEvents(round.riichiWin),
        riichiDealIn: compactEvents(round.riichiDealIn),
        riichiHitOpponent: compactEvents(round.riichiHitOpponent),
        uraSelf: compactEvents(round.uraSelf),
        opponentDora: compactEvents(round.opponentDora),
        opponentRiichiWin: compactEvents(round.opponentRiichiWin),
        uraOpponent: compactEvents(round.uraOpponent),
        selfTenpaiWin: compactEvents(round.selfTenpaiWin),
        opponentTenpaiWin: compactEvents(round.opponentTenpaiWin),
        selfTenpaiEntry: compactEvents(round.selfTenpaiEntry),
        opponentTenpaiEntry: compactEvents(round.opponentTenpaiEntry),
        initialDoraSelf: compactEvents(round.initialDoraSelf),
        initialYakuhai: compactEvents(round.initialYakuhai),
        initialDoraOpponent: compactEvents(round.initialDoraOpponent),
        otherWinAvoidLuck: compactEvents(round.otherWinAvoidLuck),
        theorySupported: Boolean(round.theorySupported)
      }))
    };
  }

  async function loadRecords() {
    if (!("indexedDB" in window)) throw new Error("このブラウザは大容量履歴保存に対応していません。IndexedDBが使えるブラウザをお使いください。");
    const database = await openDatabase();
    const stored = await new Promise((resolve, reject) => {
      const request = database.transaction(RECORD_STORE, "readonly").objectStore(RECORD_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const restored = stored
      .sort((left, right) => Number(left.position) - Number(right.position))
      .map((entry) => compactRecord(entry.record))
      .filter((record) => record?.schemaVersion === analyzer.VERSION && Array.isArray(record.rounds));
    if (restored.length) return restored;

    let legacy = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      legacy = Array.isArray(parsed) ? parsed.filter((record) => record?.schemaVersion === analyzer.VERSION).map(compactRecord) : [];
    } catch { /* broken legacy storage is ignored */ }
    if (legacy.length) {
      await saveRecords(legacy);
      localStorage.removeItem(STORAGE_KEY);
    }
    return legacy;
  }

  async function saveRecords(nextRecords = records) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction([RECORD_STORE, CACHE_STORE], "readwrite");
      const store = transaction.objectStore(RECORD_STORE);
      store.clear();
      transaction.objectStore(CACHE_STORE).clear();
      nextRecords.forEach((record, position) => {
        const compact = compactRecord(record);
        store.put({ id: compact.id, position, record: compact });
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("履歴を保存できませんでした。"));
      transaction.onabort = () => reject(transaction.error || new Error("履歴の保存が中断されました。"));
    });
    summaryCache.clear();
    localStorage.removeItem(STORAGE_KEY);
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function summaryCacheKey(subjectId = null) {
    const signature = records.map((record) => `${record.id}:${record.actualRank || ""}`).join("|");
    return `${CACHE_VERSION}:${hashText(signature)}:${records.length}:${subjectId || "all"}`;
  }

  async function loadSummaryCache() {
    const database = await openDatabase();
    const stored = await new Promise((resolve, reject) => {
      const request = database.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    stored.filter((entry) => entry?.key && entry?.summary).forEach((entry) => summaryCache.set(entry.key, entry.summary));
  }

  function getSummary(subjectId = null) {
    const key = summaryCacheKey(subjectId);
    if (summaryCache.has(key)) return summaryCache.get(key);
    const summary = analyzer.summarize(records, subjectId);
    summaryCache.set(key, summary);
    openDatabase().then((database) => new Promise((resolve, reject) => {
      const transaction = database.transaction(CACHE_STORE, "readwrite");
      transaction.objectStore(CACHE_STORE).put({ key, summary });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    })).catch(() => { /* the in-memory cache remains usable */ });
    return summary;
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

  async function addPayload(payload, meta = {}) {
    const record = compactRecord(analyzer.analyzePayload(payload, meta));
    const existing = records.findIndex((item) =>
      (record.gameId && item.gameId === record.gameId) || item.id === record.id
    );
    if (existing >= 0) {
      records[existing] = record;
      selectedId = record.id;
      scope = "selected";
      setStatus("同じ対局を最新の計算結果で更新しました。", "success");
    } else {
      records.unshift(record);
      selectedId = record.id;
      scope = "selected";
      setStatus(`${record.rounds.length}局を解析し、この端末に保存しました。`, "success");
    }
    await saveRecords();
    render();
    document.querySelector("#dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function addBundle(bundle) {
    const incoming = Array.isArray(bundle?.items) ? bundle.items : [];
    if (!incoming.length) throw new Error("一括取得ファイルに解析可能な牌譜がありません。");
    const added = [];
    let updated = 0;
    let duplicates = 0;
    let failed = 0;
    for (let index = 0; index < incoming.length; index += 1) {
      const item = incoming[index];
      try {
        const savedByTask = item?.taskId && records.find((saved) => saved.taskId === String(item.taskId));
        if (savedByTask?.calculationVersion === analyzer.CALCULATION_VERSION) {
          duplicates += 1;
          if (item && typeof item === "object") item.data = null;
          continue;
        }
        const record = compactRecord(analyzer.analyzePayload(item.data || item, {
          taskId: item.taskId || "",
          sourceUrl: item.sourceUrl || "",
          title: item.title || (item.taskId ? `BigCoach ${String(item.taskId).slice(0, 8)}` : "BigCoach解析"),
          importedAt: item.submittedAt || bundle.exportedAt,
          playerName: item.playerName || bundle.targetPlayer,
          platform: item.platform || "",
          table: item.table || ""
        }));
        const existing = records.findIndex((saved) =>
          (record.gameId && saved.gameId === record.gameId) || saved.id === record.id
        );
        const pending = added.findIndex((saved) =>
          (record.gameId && saved.gameId === record.gameId) || saved.id === record.id
        );
        if (existing >= 0) {
          records[existing] = record;
          updated += 1;
        } else if (pending >= 0) {
          added[pending] = record;
        } else {
          added.push(record);
        }
      } catch {
        failed += 1;
      }
      if (item && typeof item === "object") item.data = null;
      if (index % 4 === 3) {
        setStatus(`差分JSONを解析中… ${index + 1}/${incoming.length}対局`, "loading");
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    if (added.length || updated) {
      setStatus("集計キャッシュと着順相関モデルを更新中…", "loading");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      records.unshift(...added);
      selectedId = null;
      scope = "all";
      await saveRecords();
      render();
    }
    const remoteFailures = Number(bundle?.failures?.length || 0);
    setStatus(`一括取込: ${added.length}対局を追加、${updated}対局を最新計算へ更新、${duplicates}対局は計算済みのため省略、${failed + remoteFailures}件を取得・解析できませんでした。`, added.length || updated || duplicates ? "success" : "error");
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
      await addPayload(data, { taskId: parseReviewUrl(raw).taskId, sourceUrl: raw, title: reviewTitle(raw) });
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
    const firstContent = text.search(/\S/);
    if (firstContent < 0) throw new Error("内容が空です。");
    let source = firstContent === 0 ? text : text.slice(firstContent);
    if (source.startsWith("{") || source.startsWith("[")) {
      const parsed = JSON.parse(source);
      source = "";
      text = "";
      if (parsed?.kind === "bigcoach-luck-bundle") await addBundle(parsed);
      else if (Array.isArray(parsed?.records)) await addProcessedRecords(parsed.records);
      else await addPayload(parsed, meta);
      return;
    }
    const extracted = analyzer.extractEmbeddedJson(source);
    if (!extracted) throw new Error("HTML内に解析JSONを見つけられませんでした。ブックマークレットでJSONをコピーしてください。");
    if (extracted.dataUrl) {
      throw new Error("HTMLにはJSONのURLだけがありました。CORS制限を避けるため、ブックマークレットを実行してください。");
    }
    await addPayload(extracted, meta);
  }

  function formatNumber(value, digits = 1) {
    return value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
  }

  function signed(value, digits = 2) {
    if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
    const numeric = Number(value);
    return `${numeric >= 0 ? "+" : "−"}${Math.abs(numeric).toFixed(digits)}`;
  }

  function formatLuck(score) {
    return score != null && score !== "" && Number.isFinite(Number(score)) ? (Number(score) / 100).toFixed(3) : "—";
  }

  async function addProcessedRecords(incoming) {
    const valid = incoming
      .filter((record) => record?.schemaVersion === analyzer.VERSION && Array.isArray(record.rounds))
      .map(compactRecord);
    if (!valid.length) throw new Error("この履歴は旧計算方式です。元のBigCoach JSONから再取り込みしてください。");
    let added = 0;
    let updated = 0;
    for (const record of valid) {
      const existing = records.findIndex((saved) => (record.gameId && saved.gameId === record.gameId) || saved.id === record.id);
      if (existing >= 0) {
        records[existing] = record;
        updated += 1;
      } else {
        records.push(record);
        added += 1;
      }
    }
    await saveRecords();
    scope = "all";
    selectedId = null;
    render();
    setStatus(`${added}対局を追加、${updated}対局を更新しました。`, "success");
  }

  function luckLabel(score) {
    if (score == null || score === "" || !Number.isFinite(Number(score))) return "データ不足";
    if (score >= 90) return "かなり上振れ";
    if (score >= 70) return "やや上振れ";
    if (score <= 10) return "かなり下振れ";
    if (score <= 30) return "やや下振れ";
    return "おおむね中央";
  }

  function setExperienceMetric(prefix, result, formatter) {
    const score = result.percentile;
    document.querySelector(`#${prefix}-percentile`).textContent = formatLuck(score);
    document.querySelector(`#${prefix}-meter`).style.width = `${score || 0}%`;
    document.querySelector(`#${prefix}-detail`).textContent = result.n
      ? `${luckLabel(score)} · ${formatter(result)} · U=${formatLuck(score)} / 両側p ${formatNumber(result.pValue, 3)} · 対象${result.n}局 / 経験分布${result.poolN}局${result.included ? "" : `（指数算入は${result.minimum}局から）`}`
      : "対象データがありません";
  }

  function setTheoryMetric(prefix, result, noun) {
    const score = result.percentile;
    const observedRate = result.n ? result.observed / result.n * 100 : null;
    const expectedRate = result.n ? result.expected / result.n * 100 : null;
    document.querySelector(`#${prefix}-percentile`).textContent = formatLuck(score);
    document.querySelector(`#${prefix}-detail`).textContent = result.n
      ? `${luckLabel(score)} · 実率 ${formatNumber(observedRate, 2)}% / 理論率 ${formatNumber(expectedRate, 2)}% · 実績 ${formatNumber(result.observed, 0)} / 理論 ${formatNumber(result.expected, 2)} ${noun}（n=${result.n}）· z ${signed(result.luckZ, 2)} · U=${formatLuck(score)} / 両側p ${formatNumber(result.pValue, 3)}`
      : "MJAIイベントから計算できる対象機会がありません";
    const position = score == null ? 50 : Math.max(4, Math.min(96, score));
    document.querySelector(`#${prefix}-marker`).style.left = `${position}%`;
  }

  function renderMetrics(summary) {
    const overall = summary.overall;
    document.querySelector("#overall-score").textContent = formatLuck(overall.score);
    document.querySelector("#overall-label").textContent = overall.score == null
      ? "評価できる指標を蓄積中"
      : overall.score >= 90 ? "かなり運が良い"
        : overall.score >= 70 ? "やや運が良い"
          : overall.score <= 10 ? "かなり運が悪い"
            : overall.score <= 30 ? "やや運が悪い" : "おおむね標準的";
    document.querySelector("#overall-detail").textContent = overall.score == null
      ? "総合運に入れられる指標がまだありません。"
      : `${overall.included.length}/${overall.totalComponents}指標を非負係数で加重し、その加重点を${overall.distributionN}半荘の同時経験分布へ通したU[0,1]です。指標間の重複・相関も保ちます。Uは上振れ方向の累積確率で、両側p値は${formatNumber(overall.pValue, 3)}です。`;
    const weightText = Object.entries(overall.weights || {})
      .filter(([, weight]) => Number(weight) >= 0.0005)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .map(([key, weight]) => `${METRIC_LABELS[key]} ${formatNumber(weight * 100, 1)}%`)
      .join(" / ");
    document.querySelector("#overall-model").textContent = overall.fittedWeights
      ? `1行=1半荘、目的変数=5−最終着順、対象なしはU=0.5で補完する非負リッジ回帰 · 半荘単位の説明相関: 5分割検証 r=${formatNumber(overall.validationCorrelation, 3)} / 学習内 r=${formatNumber(overall.correlation, 3)}（${overall.correlationN}半荘、L2=${formatNumber(overall.ridgePenalty, 0)}）· 重み（0.05%未満は省略）: ${weightText}`
      : `実着順を保存した半荘が不足しているため均等重みです（${overall.correlationN}/20半荘）。既存履歴は元の差分JSONを再取り込みすると着順が補完されます。`;
    const overallComponents = document.querySelector("#overall-components");
    overallComponents.replaceChildren(
      ...overall.included.map((component) => overallChip(`${component.label} ${formatLuck(component.score)}`, false)),
      ...overall.excluded.map((component) => overallChip(`${component.label}: ${component.reason}`, true))
    );
    setExperienceMetric("deal", summary.deal, (result) => `平均和了予測 ${formatNumber(result.value * 100, 1)}%`);
    setExperienceMetric("rank", summary.rankDeal, (result) => `平均順位ショック ${signed(result.value, 3)}`);
    setExperienceMetric("defense", summary.defense, (result) => `実績放銃 ${formatNumber(result.observed, 0)} / 予測合計 ${formatNumber(result.predicted, 2)}（${result.events}打牌）`);
    setTheoryMetric("dora", summary.dora, "回");
    setTheoryMetric("effective", summary.effective, "回");
    setTheoryMetric("effective-2", summary.effective2, "回");
    setTheoryMetric("effective-1", summary.effective1, "回");
    setTheoryMetric("riichi-win", summary.riichiWin, "回");
    setTheoryMetric("riichi-danger", summary.riichiDealIn, "回");
    setTheoryMetric("genbutsu", summary.genbutsu, "回");
    setTheoryMetric("genbutsu-1", summary.genbutsu1, "回");
    setTheoryMetric("genbutsu-tenpai", summary.genbutsuTenpai, "回");
    setTheoryMetric("fuuro-genbutsu", summary.fuuroGenbutsu, "回");
    setTheoryMetric("fuuro-genbutsu-1", summary.fuuroGenbutsu1, "回");
    setTheoryMetric("fuuro-genbutsu-tenpai", summary.fuuroGenbutsuTenpai, "回");
    setTheoryMetric("waste-draw", summary.wasteDraw, "回");
    setTheoryMetric("riichi-hit-opponent", summary.riichiHitOpponent, "回");
    setTheoryMetric("ura-self", summary.uraSelf, "枚");
    setTheoryMetric("opponent-dora", summary.opponentDora, "回");
    setTheoryMetric("opponent-riichi-win", summary.opponentRiichiWin, "回");
    setTheoryMetric("ura-opponent", summary.uraOpponent, "枚");
    setTheoryMetric("self-tenpai-win", summary.selfTenpaiWin, "回");
    setTheoryMetric("opponent-tenpai-win", summary.opponentTenpaiWin, "回");
    setTheoryMetric("self-tenpai-entry", summary.selfTenpaiEntry, "回");
    setTheoryMetric("opponent-tenpai-entry", summary.opponentTenpaiEntry, "回");
    setTheoryMetric("initial-dora-self", summary.initialDoraSelf, "枚");
    setTheoryMetric("initial-yakuhai", summary.initialYakuhai, "組");
    setTheoryMetric("initial-dora-opponent", summary.initialDoraOpponent, "枚");
    setExperienceMetric("otherwin-avoid-luck", summary.otherWinAvoidLuck, (result) => `標準化残差 ${signed(result.value, 2)}`);
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

  function weightedRecordScore(scores, weights) {
    const entries = Object.entries(weights || {}).filter(([, weight]) => Number(weight) > 0);
    if (!entries.some(([key]) => Number.isFinite(scores?.[key]))) return null;
    const total = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
    return total > 0 ? entries.reduce((sum, [key, weight]) => sum + (Number.isFinite(scores?.[key]) ? scores[key] : 50) * Number(weight), 0) / total : null;
  }

  function initializeTrendSelection(weights) {
    if (trendSelectionInitialized) return;
    const topFive = Object.entries(weights || {})
      .filter(([key, weight]) => key in METRIC_LABELS && Number.isFinite(Number(weight)))
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 5)
      .map(([key]) => key);
    trendVisible.clear();
    trendVisible.add("actualRankPlot");
    trendVisible.add("overall");
    topFive.forEach((key) => trendVisible.add(key));
    trendSelectionInitialized = true;
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
    const model = analyzer.fitOutcomeWeights(chronological);
    initializeTrendSelection(model.weights);
    const recordScores = analyzer.recordMetricScores(chronological);
    const rawOverallScores = recordScores.map((row) => weightedRecordScore(row.scores, model.weights));
    const allPoints = recordScores.map((row, gameIndex) => ({
      gameIndex,
      date: row.importedAt,
      title: row.title,
      actualRank: row.actualRank,
      actualRankPlot: Number.isInteger(row.actualRank) ? (4 - row.actualRank) / 3 * 100 : null,
      ...row.scores,
      overall: analyzer.empiricalPercentile(rawOverallScores[gameIndex], rawOverallScores)
    }));
    const limit = trendLimit === "all" ? allPoints.length : Number(trendLimit);
    const points = allPoints.slice(-Math.max(1, limit));
    const series = [
      { key: "actualRankPlot", label: "実際の着順", color: "#111827", width: 2.4, dash: "7 4" },
      { key: "overall", label: "総合運", color: "#12614f", width: 3.5 },
      { key: "deal", label: METRIC_LABELS.deal, color: "#d98d3b", width: 1.8 },
      { key: "rankDeal", label: METRIC_LABELS.rankDeal, color: "#b66a2b", width: 1.8 },
      { key: "defense", label: METRIC_LABELS.defense, color: "#b45145", width: 1.8 },
      { key: "dora", label: METRIC_LABELS.dora, color: "#287cb5", width: 1.8 },
      { key: "effective", label: METRIC_LABELS.effective, color: "#2d9aa0", width: 1.8 },
      { key: "effective2", label: METRIC_LABELS.effective2, color: "#23858d", width: 1.8 },
      { key: "effective1", label: METRIC_LABELS.effective1, color: "#35aeb4", width: 1.8 },
      { key: "riichiWin", label: METRIC_LABELS.riichiWin, color: "#7656a8", width: 1.8 },
      { key: "riichiDealIn", label: METRIC_LABELS.riichiDealIn, color: "#b04f91", width: 1.8 },
      { key: "genbutsu", label: METRIC_LABELS.genbutsu, color: "#70843b", width: 1.8 },
      { key: "genbutsu1", label: METRIC_LABELS.genbutsu1, color: "#849b47", width: 1.8 },
      { key: "genbutsuTenpai", label: METRIC_LABELS.genbutsuTenpai, color: "#627532", width: 1.8 },
      { key: "fuuroGenbutsu", label: METRIC_LABELS.fuuroGenbutsu, color: "#507a5b", width: 1.8 },
      { key: "fuuroGenbutsu1", label: METRIC_LABELS.fuuroGenbutsu1, color: "#669873", width: 1.8 },
      { key: "fuuroGenbutsuTenpai", label: METRIC_LABELS.fuuroGenbutsuTenpai, color: "#3e6248", width: 1.8 },
      { key: "wasteDraw", label: METRIC_LABELS.wasteDraw, color: "#3c8992", width: 1.8 },
      { key: "riichiHitOpponent", label: METRIC_LABELS.riichiHitOpponent, color: "#8e5a9b", width: 1.8 },
      { key: "uraSelf", label: METRIC_LABELS.uraSelf, color: "#d14f73", width: 1.8 },
      { key: "selfTenpaiWin", label: METRIC_LABELS.selfTenpaiWin, color: "#6246a8", width: 1.8 },
      { key: "selfTenpaiEntry", label: METRIC_LABELS.selfTenpaiEntry, color: "#3f63ad", width: 1.8 },
      { key: "initialDoraSelf", label: METRIC_LABELS.initialDoraSelf, color: "#1f8aa6", width: 1.8 },
      { key: "initialYakuhai", label: METRIC_LABELS.initialYakuhai, color: "#3c70a4", width: 1.8 },
      { key: "opponentDora", label: METRIC_LABELS.opponentDora, color: "#9b7b27", width: 1.8 },
      { key: "opponentRiichiWin", label: METRIC_LABELS.opponentRiichiWin, color: "#9a483f", width: 1.8 },
      { key: "uraOpponent", label: METRIC_LABELS.uraOpponent, color: "#be6b35", width: 1.8 },
      { key: "opponentTenpaiWin", label: METRIC_LABELS.opponentTenpaiWin, color: "#7c6530", width: 1.8 },
      { key: "opponentTenpaiEntry", label: METRIC_LABELS.opponentTenpaiEntry, color: "#58733a", width: 1.8 },
      { key: "initialDoraOpponent", label: METRIC_LABELS.initialDoraOpponent, color: "#3d7764", width: 1.8 },
      { key: "otherWinAvoidLuck", label: METRIC_LABELS.otherWinAvoidLuck, color: "#6b728e", width: 1.8 }
    ];
    for (const item of series) {
      const chip = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = trendVisible.has(item.key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) trendVisible.add(item.key);
        else trendVisible.delete(item.key);
        renderTrend();
      });
      const swatch = document.createElement("i");
      swatch.style.background = item.color;
      chip.append(checkbox, swatch, document.createTextNode(item.label));
      elements.trendLegend.append(chip);
    }

    const left = 48, right = 900, top = 18, bottom = 252;
    for (const value of [0, 25, 50, 75, 100]) {
      const y = bottom - (value / 100) * (bottom - top);
      elements.trendChart.append(
        svgElement("line", { x1: left, y1: y, x2: right, y2: y, class: value === 50 ? "trend-midline" : "trend-gridline" }),
        svgElement("text", { x: left - 9, y: y + 4, "text-anchor": "end", class: "trend-axis-label" }, (value / 100).toFixed(2))
      );
    }
    const xFor = (index) => points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
    const yFor = (value) => bottom - Number(value) / 100 * (bottom - top);
    for (const item of series) {
      if (!trendVisible.has(item.key)) continue;
      const valid = points.map((point, index) => ({ point, index, value: point[item.key] })).filter((entry) => Number.isFinite(entry.value));
      if (!valid.length) continue;
      const path = valid.map((entry, index) => `${index ? "L" : "M"}${xFor(entry.index).toFixed(1)},${yFor(entry.value).toFixed(1)}`).join(" ");
      elements.trendChart.append(svgElement("path", { d: path, fill: "none", stroke: item.color, "stroke-width": item.width, "stroke-dasharray": item.dash || "", class: "trend-line" }));
      for (const entry of valid) {
        const circle = svgElement("circle", { cx: xFor(entry.index), cy: yFor(entry.value), r: item.key === "overall" ? 3.2 : 2.2, fill: item.color });
        const date = new Date(entry.point.date).toLocaleDateString("ja-JP");
        const rank = entry.point.actualRank && item.key !== "actualRankPlot" ? ` · ${entry.point.actualRank}着` : "";
        const valueLabel = item.key === "actualRankPlot" ? `${entry.point.actualRank}着` : `U=${formatLuck(entry.value)}`;
        circle.append(svgElement("title", {}, `${date} · ${entry.point.title}${rank} · ${item.label} ${valueLabel}`));
        elements.trendChart.append(circle);
      }
    }
    const first = points[0], last = points[points.length - 1];
    elements.trendChart.append(
      svgElement("text", { x: left, y: 282, "text-anchor": "start", class: "trend-axis-label" }, `${new Date(first.date).toLocaleDateString("ja-JP")} · ${first.gameIndex + 1}半荘目`),
      svgElement("text", { x: right, y: 282, "text-anchor": "end", class: "trend-axis-label" }, `${new Date(last.date).toLocaleDateString("ja-JP")} · ${last.gameIndex + 1}半荘目`)
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
      const theoryRounds = (record.rounds || []).filter((round) => round.theorySupported).length;
      fragment.querySelector(".history-meta").textContent = `${record.actualRank ? `${record.actualRank}着 · ` : ""}${record.rounds?.length || 0}局 · 理論計算 ${theoryRounds}局`;
      fragment.querySelector(".history-main").addEventListener("click", () => {
        selectedId = record.id;
        scope = "selected";
        render();
        document.querySelector("#dashboard").scrollIntoView({ behavior: "smooth" });
      });
      fragment.querySelector(".delete-button").addEventListener("click", async () => {
        if (!window.confirm(`「${record.title}」を端末から削除しますか？`)) return;
        records = records.filter((item) => item.id !== record.id);
        if (selectedId === record.id) selectedId = null;
        if (!selectedId) scope = "all";
        await saveRecords();
        render();
      });
      elements.history.append(item);
    });
  }

  function renderRecordSelector() {
    const current = selectedId || records[0]?.id || "";
    const options = records.map((record) => {
      const option = document.createElement("option");
      option.value = record.id;
      const date = new Date(record.importedAt).toLocaleDateString("ja-JP");
      const rank = record.actualRank ? ` · ${record.actualRank}着` : "";
      option.textContent = `${date}${rank} · ${record.title}`;
      return option;
    });
    elements.recordSelect.replaceChildren(...options);
    elements.recordSelect.value = current;
  }

  function render() {
    const allSummary = getSummary();
    const selectedExists = records.some((record) => record.id === selectedId);
    if (!selectedExists) selectedId = null;
    if (!selectedId) scope = "all";
    const summary = scope === "selected" && selectedId ? getSummary(selectedId) : allSummary;
    document.querySelector("#hero-records").textContent = records.length;
    document.querySelector("#hero-rounds").textContent = allSummary.rounds;
    document.querySelector("#hero-pool").textContent = allSummary.theorySupportedRounds;
    elements.empty.hidden = records.length > 0;
    elements.metrics.hidden = records.length === 0;
    elements.export.disabled = records.length === 0;
    elements.dashboardControls.hidden = records.length === 0;
    renderRecordSelector();
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
      setStatus(`${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB）を読み込み中…`, "loading");
      await handleText(await file.text(), { title: file.name.replace(/\.(json|html?)$/i, "") });
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      elements.file.value = "";
    }
  });
  elements.demo.addEventListener("click", async () => {
    try {
      await addPayload(DEMO_DATA, { title: "デモ牌譜" });
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
  elements.export.addEventListener("click", downloadJson);
  elements.scopeButtons.forEach((button) => button.addEventListener("click", () => {
    scope = button.dataset.scope;
    if (scope === "selected" && !selectedId) selectedId = elements.recordSelect.value || records[0]?.id || null;
    render();
  }));
  elements.recordSelect.addEventListener("change", () => {
    selectedId = elements.recordSelect.value || null;
    scope = selectedId ? "selected" : "all";
    render();
  });
  elements.trendLimit.addEventListener("change", () => {
    trendLimit = elements.trendLimit.value;
    renderTrend();
  });

  async function initialize() {
    buildBookmarklet();
    setStatus("保存履歴を読み込み中…", "loading");
    try {
      records = await loadRecords();
      await loadSummaryCache();
      navigator.storage?.persist?.().catch(() => false);
      const outdated = records.filter((record) => record.calculationVersion !== analyzer.CALCULATION_VERSION).length;
      setStatus(outdated
        ? `${records.length}対局を読み込みました。${outdated}対局へ実着順と最新計算を追加するため、前回の差分JSONをもう一度取り込んでください（既存履歴は置換されます）。`
        : records.length ? `${records.length}対局の計算済み履歴を読み込みました。` : "", outdated ? "loading" : records.length ? "success" : "");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      render();
    } catch (error) {
      setStatus(`保存領域を準備できませんでした: ${error.message}`, "error");
      render();
    }
  }

  initialize();
})();
