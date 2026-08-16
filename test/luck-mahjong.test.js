const test = require("node:test");
const assert = require("node:assert/strict");
const {
  tile34,
  tileName,
  shanten,
  improvingTiles,
  winningTiles,
  doraFromMarker
} = require("../docs/mahjong.js");

test("牌表現とドラ表示牌を34種へ変換する", () => {
  assert.equal(tile34("5mr"), 4);
  assert.equal(tileName(33), "C");
  assert.equal(tileName(doraFromMarker("9p")), "1p");
  assert.equal(tileName(doraFromMarker("N")), "E");
  assert.equal(tileName(doraFromMarker("C")), "P");
});

test("通常手の聴牌と和了牌を計算する", () => {
  const hand = ["1m", "1m", "1m", "2m", "3m", "4m", "2p", "3p", "4p", "2s", "3s", "4s", "E"];
  assert.equal(shanten(hand), 0);
  assert.deepEqual(winningTiles(hand).map(tileName), ["E"]);
});

test("七対子と国士を向聴計算に含める", () => {
  const chiitoi = ["1m", "1m", "2m", "2m", "3p", "3p", "4p", "4p", "5s", "5s", "E", "E", "C"];
  assert.equal(shanten(chiitoi), 0);
  assert.ok(winningTiles(chiitoi).map(tileName).includes("C"));
  const kokushi = ["1m", "9m", "1p", "9p", "1s", "9s", "E", "S", "W", "N", "P", "F", "C"];
  assert.equal(shanten(kokushi), 0);
  assert.equal(winningTiles(kokushi).length, 13);
});

test("有効牌は向聴数を小さくする牌だけ", () => {
  const hand = ["1m", "2m", "3m", "4m", "5m", "6m", "2p", "3p", "4p", "7s", "8s", "E", "E"];
  const current = shanten(hand);
  const ids = improvingTiles(hand);
  assert.ok(ids.length > 0);
  for (const id of ids) assert.ok(shanten([...hand, tileName(id)]) < current);
});
