const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  analyzePayload,
  summarize,
  martingale,
  empiricalPercentile,
  bootstrapPercentile,
  cauchyCombine,
  recordMetricScores,
  roundMetricScores,
  fitOutcomeWeights,
  VERSION
} = require("../docs/analyzer.js");

test("逐次確率残差は観測−期待を条件付き分散で標準化する", () => {
  const result = martingale([{ p: 0.25, y: 1 }, { p: 0.5, y: 0 }]);
  const expected = (1 - 0.25 + 0 - 0.5) / Math.sqrt(0.25 * 0.75 + 0.5 * 0.5);
  assert.equal(result.n, 2);
  assert.ok(Math.abs(result.rawZ - expected) < 1e-12);
  assert.ok(result.pValue > 0 && result.pValue <= 1);
  const uniformLuck = result.u;
  assert.ok(uniformLuck >= 0 && uniformLuck <= 1);
  assert.ok(Math.abs(result.pValue - 2 * Math.min(uniformLuck, 1 - uniformLuck)) < 1e-12);
});

test("危険牌は符号を反転すると掴まないほど幸運になる", () => {
  const result = martingale([{ p: 0.2, y: 0 }, { p: 0.2, y: 0 }], -1);
  assert.ok(result.rawZ < 0);
  assert.ok(result.luckZ > 0);
  assert.ok(result.percentile > 50);
});

test("裏ドラなどの有限母集団分散を逐次残差に使える", () => {
  const result = martingale([{ p: 1.2, y: 2, v: 0.4 }]);
  assert.equal(result.variance, 0.4);
  assert.ok(Math.abs(result.rawZ - 0.8 / Math.sqrt(0.4)) < 1e-12);
});

test("経験percentileは同順位の中点を使う", () => {
  assert.equal(empiricalPercentile(2, [1, 2, 2, 3]), 50);
  const percentile = bootstrapPercentile([2, 3], [1, 2, 3, 4], "fixed");
  assert.ok(percentile > 0 && percentile < 100);
});

test("Cauchy結合は有効なp値だけをまとめる", () => {
  assert.equal(cauchyCombine([null, Number.NaN]), null);
  assert.equal(cauchyCombine([0.2]), 0.2);
  const combined = cauchyCombine([0.01, 0.2, 0.7]);
  assert.ok(combined > 0 && combined < 0.2);
});

test("BigCoach実例から27指標と理論ツモを抽出できる", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8"));
  const record = analyzePayload(fixture, { title: "fixture", taskId: "fixture-task" });
  const summary = summarize([record]);
  assert.equal(record.schemaVersion, VERSION);
  assert.equal(record.rounds.length, 8);
  assert.equal(summary.theorySupportedRounds, 8);
  assert.ok(summary.deal.n > 0);
  assert.ok(summary.rankDeal.n > 0);
  assert.ok(summary.defense.events > 0);
  assert.ok(summary.dora.n > 0);
  assert.ok(summary.effective.n > 0);
  assert.ok(summary.effective2.n > 0);
  assert.ok(summary.effective1.n > 0);
  assert.ok(summary.opponentDora.n > 0);
  assert.ok(summary.selfTenpaiEntry.n > 0);
  assert.ok(summary.opponentTenpaiEntry.n > 0);
  assert.ok(summary.initialDoraSelf.n > 0);
  assert.ok(summary.initialDoraOpponent.n > 0);
  assert.equal(record.players.length, 4);
  assert.equal(record.opponents.length, 3);
  assert.equal(record.actualRank, 3);
  assert.equal(record.finalScore, 19700);
  assert.equal(record.taskId, "fixture-task");
  assert.ok(record.calculationVersion > 0);
  assert.equal(roundMetricScores([record]).length, record.rounds.length);
  assert.ok(record.rounds.flatMap((round) => round.riichiDealIn).every((event) => event.p > 0));
  assert.ok(Array.isArray(summary.fairness.groups));
  assert.ok(Array.isArray(summary.fairness.diagnostics));
  assert.deepEqual(summary.fairness.groups.map((item) => item.key), ["theory", "bigcoach", "all"]);
  assert.equal(summary.fairness.groups.find((item) => item.key === "all").pValue, null);
  assert.ok(record.rounds.some((round) => round.outcomeLuck.length > 0));
  assert.equal(summary.overall.totalComponents, 27);
  assert.equal(summary.overall.u, 0.5);
  assert.equal(summary.overall.distributionN, 1);
});

test("同じ元牌譜はモデル確率が変わってもgameIdが同じ", () => {
  const mjai = [
    { type: "start_kyoku", oya: 0, dora_marker: "1m", tehais: [[], [], [], []] },
    { type: "end_kyoku" }
  ];
  const make = (p) => ({
    player_id: 0,
    mjai_log: mjai,
    review: { kyokus: [{ kyoku: 0, entries: [{ actual: { type: "dahai", actor: 0, pai: "1m" }, sl_outcome: [p, 0] }], end_status: [] }] }
  });
  const first = analyzePayload(make(0.2));
  const second = analyzePayload(make(0.8));
  assert.equal(first.gameId, second.gameId);
  assert.notEqual(first.id, second.id);
});

test("メタデータだけのresultは解析JSONとして拒否する", () => {
  assert.throws(() => analyzePayload({ success: true, data: { jsonUrl: "/x" } }), /review\.kyokus/);
});

test("履歴差分のプレイヤー名は画面入力から生成し、固定名を持たない", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "docs", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "docs", "app.js"), "utf8");
  assert.match(html, /id="history-player"/);
  assert.match(html, /ふだんは、こちらだけ使います/);
  assert.match(html, /id="trend-chart"/);
  assert.match(html, /id="trend-limit"/);
  assert.match(html, /id="record-select"/);
  assert.match(html, /id="ura-self-percentile"/);
  assert.match(html, /id="opponent-tenpai-win-percentile"/);
  assert.match(html, /総合運と27指標/);
  assert.match(html, /2シャンテン時有効牌ツモ率/);
  assert.match(html, /確率決着収支/);
  assert.match(html, /重みが大きい上位5指標/);
  assert.match(html, /U\[0,1\]/);
  assert.doesNotMatch(app, /const target='はうらC'/);
  assert.match(app, /indexedDB\.open/);
  assert.match(app, /analysis-cache/);
  assert.match(app, /validationCorrelation/);
  assert.match(app, /initializeTrendSelection\(model\.weights\)/);
  assert.match(app, /\.slice\(0, 5\)/);
  assert.match(app, /empiricalPercentile\(rawOverallScores\[roundIndex\], rawOverallScores\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\(STORAGE_KEY/);
});

test("局開始時5結果確率を排他的な実現結果残差へ変換する", () => {
  const record = analyzePayload({
    player_id: 0,
    review: { kyokus: [{
      kyoku: 0,
      entries: [{ actual: { type: "dahai", actor: 0, pai: "1m" }, sl_outcome: [0.1, 0.2, 0.3, 0.25, 0.15] }],
      end_status: [{ type: "hora", actor: 0, target: 2 }]
    }] }
  });
  const round = record.rounds[0];
  assert.deepEqual(round.tsumoLuck[0], { p: 0.1, y: 0 });
  assert.deepEqual(round.ronLuck[0], { p: 0.2, y: 1 });
  assert.deepEqual(round.dealInAvoidLuck[0], { p: 0.3, y: 0 });
  assert.deepEqual(round.otherWinAvoidLuck[0], { p: 0.25, y: 0 });
  assert.ok(Math.abs(round.outcomeLuck[0].p) < 1e-12);
  assert.equal(round.outcomeLuck[0].y, 1);
  assert.ok(Math.abs(round.outcomeLuck[0].v - 0.6) < 1e-12);
});

test("最終着順と最終点棒は運指標の入力に混ぜない", () => {
  const rounds = [{
    deal: { value: 0.3 }, rankDeal: { value: 0.1 }, chancePoints: 2,
    outcomeLuck: [{ p: 0.2, y: 1 }], tsumoLuck: [{ p: 0.1, y: 1 }],
    ronLuck: [{ p: 0.1, y: 0 }], dealInAvoidLuck: [{ p: 0.2, y: 0 }], otherWinAvoidLuck: [{ p: 0.3, y: 0 }]
  }];
  const first = { id: "a", actualRank: 1, finalScore: 50000, rounds };
  const second = { id: "b", actualRank: 4, finalScore: -1000, rounds };
  const [left, right] = recordMetricScores([first, second]);
  assert.deepEqual(left.scores, right.scores);
});

test("実着順との相関重みは非負で合計1になる", () => {
  const records = [];
  for (let repeat = 0; repeat < 6; repeat += 1) {
    for (let rank = 1; rank <= 4; rank += 1) {
      const wins = 4 - rank;
      records.push({
        id: `rank-${rank}-${repeat}`,
        importedAt: new Date(2026, 0, records.length + 1).toISOString(),
        actualRank: rank,
        rounds: [{
          effective: Array.from({ length: 4 }, (_, index) => ({ p: 0.5, y: index < wins ? 1 : 0 })),
          defense: [], dora: [], genbutsu: [], riichiWin: [], riichiDealIn: []
        }]
      });
    }
  }
  const rows = recordMetricScores(records);
  const model = fitOutcomeWeights(records);
  assert.equal(rows.length, 24);
  assert.equal(model.sampleN, 24);
  assert.ok(model.fitted);
  assert.ok(model.correlation > 0.9);
  assert.ok(Object.values(model.weights).every((weight) => weight >= 0));
  assert.ok(Math.abs(Object.values(model.weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  assert.ok(model.weights.effective > 0.99);
});
