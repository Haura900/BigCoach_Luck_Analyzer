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
  VERSION
} = require("../docs/analyzer.js");

test("逐次確率残差は観測−期待を条件付き分散で標準化する", () => {
  const result = martingale([{ p: 0.25, y: 1 }, { p: 0.5, y: 0 }]);
  const expected = (1 - 0.25 + 0 - 0.5) / Math.sqrt(0.25 * 0.75 + 0.5 * 0.5);
  assert.equal(result.n, 2);
  assert.ok(Math.abs(result.rawZ - expected) < 1e-12);
  assert.ok(result.pValue > 0 && result.pValue <= 1);
});

test("危険牌は符号を反転すると掴まないほど幸運になる", () => {
  const result = martingale([{ p: 0.2, y: 0 }, { p: 0.2, y: 0 }], -1);
  assert.ok(result.rawZ < 0);
  assert.ok(result.luckZ > 0);
  assert.ok(result.percentile > 50);
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

test("BigCoach実例から8指標と理論ツモを抽出できる", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8"));
  const record = analyzePayload(fixture, { title: "fixture" });
  const summary = summarize([record]);
  assert.equal(record.schemaVersion, VERSION);
  assert.equal(record.rounds.length, 8);
  assert.equal(summary.theorySupportedRounds, 8);
  assert.ok(summary.deal.n > 0);
  assert.ok(summary.rankDeal.n > 0);
  assert.ok(summary.defense.events > 0);
  assert.ok(summary.dora.n > 0);
  assert.ok(summary.effective.n > 0);
  assert.equal(record.players.length, 4);
  assert.equal(record.opponents.length, 3);
  assert.ok(Array.isArray(summary.fairness.groups));
  assert.ok(Array.isArray(summary.fairness.diagnostics));
  assert.deepEqual(summary.fairness.groups.map((item) => item.key), ["theory", "bigcoach", "all"]);
  assert.equal(summary.fairness.groups.find((item) => item.key === "all").pValue, null);
  assert.equal(summary.overall.totalComponents, 8);
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
  assert.doesNotMatch(app, /const target='はうらC'/);
  assert.match(app, /indexedDB\.open/);
  assert.doesNotMatch(app, /localStorage\.setItem\(STORAGE_KEY/);
});
