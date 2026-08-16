(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MahjongLuckCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HONORS = { E: 27, S: 28, W: 29, N: 30, P: 31, F: 32, C: 33 };
  const HONOR_NAMES = ["E", "S", "W", "N", "P", "F", "C"];
  const TERMINAL_HONOR_IDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  const SHANTEN_CACHE = new Map();

  function tile34(tile) {
    if (tile == null) return -1;
    const text = String(tile).trim();
    if (Object.prototype.hasOwnProperty.call(HONORS, text)) return HONORS[text];
    const match = text.match(/^([1-9])([mps])r?$/);
    if (!match) return -1;
    const offset = match[2] === "m" ? 0 : match[2] === "p" ? 9 : 18;
    return offset + Number(match[1]) - 1;
  }

  function tileName(id) {
    const value = Number(id);
    if (!Number.isInteger(value) || value < 0 || value > 33) return null;
    if (value >= 27) return HONOR_NAMES[value - 27];
    const suit = value < 9 ? "m" : value < 18 ? "p" : "s";
    return `${value % 9 + 1}${suit}`;
  }

  function isRed(tile) {
    return /^[5][mps]r$/.test(String(tile || ""));
  }

  function counts34(tiles) {
    const counts = Array(34).fill(0);
    for (const tile of tiles || []) {
      const id = tile34(tile);
      if (id >= 0) counts[id] += 1;
    }
    return counts;
  }

  function normalShanten(counts, openMelds) {
    let best = 8;
    const open = Math.max(0, Math.min(4, Number(openMelds) || 0));

    function finish(mentsu, taatsu, pair) {
      const meldTotal = open + mentsu;
      const usableTaatsu = Math.min(taatsu, Math.max(0, 4 - meldTotal));
      best = Math.min(best, 8 - meldTotal * 2 - usableTaatsu - pair);
    }

    function walk(start, mentsu, taatsu, pair) {
      while (start < 34 && counts[start] === 0) start += 1;
      if (start >= 34) {
        finish(mentsu, taatsu, pair);
        return;
      }

      // Skipping an isolated tile is necessary to enumerate every decomposition.
      counts[start] -= 1;
      walk(start, mentsu, taatsu, pair);
      counts[start] += 1;

      if (counts[start] >= 3) {
        counts[start] -= 3;
        walk(start, mentsu + 1, taatsu, pair);
        counts[start] += 3;
      }

      if (start < 27 && start % 9 <= 6 && counts[start + 1] && counts[start + 2]) {
        counts[start] -= 1;
        counts[start + 1] -= 1;
        counts[start + 2] -= 1;
        walk(start, mentsu + 1, taatsu, pair);
        counts[start] += 1;
        counts[start + 1] += 1;
        counts[start + 2] += 1;
      }

      if (counts[start] >= 2) {
        counts[start] -= 2;
        if (!pair) walk(start, mentsu, taatsu, 1);
        walk(start, mentsu, taatsu + 1, pair);
        counts[start] += 2;
      }

      if (start < 27 && start % 9 <= 7 && counts[start + 1]) {
        counts[start] -= 1;
        counts[start + 1] -= 1;
        walk(start, mentsu, taatsu + 1, pair);
        counts[start] += 1;
        counts[start + 1] += 1;
      }

      if (start < 27 && start % 9 <= 6 && counts[start + 2]) {
        counts[start] -= 1;
        counts[start + 2] -= 1;
        walk(start, mentsu, taatsu + 1, pair);
        counts[start] += 1;
        counts[start + 2] += 1;
      }
    }

    walk(0, 0, 0, 0);
    return best;
  }

  function shanten(tiles, openMelds = 0) {
    const counts = counts34(tiles);
    const open = Math.max(0, Math.min(4, Number(openMelds) || 0));
    const key = `${open}:${counts.join("")}`;
    if (SHANTEN_CACHE.has(key)) return SHANTEN_CACHE.get(key);

    let best = normalShanten(counts.slice(), open);
    if (open === 0) {
      const pairs = counts.filter((value) => value >= 2).length;
      const distinct = counts.filter(Boolean).length;
      const chiitoi = 6 - pairs + Math.max(0, 7 - distinct);
      const unique = TERMINAL_HONOR_IDS.filter((id) => counts[id] > 0).length;
      const pair = TERMINAL_HONOR_IDS.some((id) => counts[id] >= 2) ? 1 : 0;
      const kokushi = 13 - unique - pair;
      best = Math.min(best, chiitoi, kokushi);
    }
    SHANTEN_CACHE.set(key, best);
    return best;
  }

  function improvingTiles(tiles, openMelds = 0) {
    const current = shanten(tiles, openMelds);
    const inHand = counts34(tiles);
    const result = [];
    for (let id = 0; id < 34; id += 1) {
      if (inHand[id] >= 4) continue;
      if (shanten([...(tiles || []), tileName(id)], openMelds) < current) result.push(id);
    }
    return result;
  }

  function winningTiles(tiles, openMelds = 0) {
    if (shanten(tiles, openMelds) !== 0) return [];
    const inHand = counts34(tiles);
    const result = [];
    for (let id = 0; id < 34; id += 1) {
      if (inHand[id] >= 4) continue;
      if (shanten([...(tiles || []), tileName(id)], openMelds) === -1) result.push(id);
    }
    return result;
  }

  function doraFromMarker(marker) {
    const id = tile34(marker);
    if (id < 0) return -1;
    if (id < 27) {
      const suitStart = Math.floor(id / 9) * 9;
      return suitStart + ((id - suitStart + 1) % 9);
    }
    if (id <= 30) return 27 + ((id - 27 + 1) % 4);
    return 31 + ((id - 31 + 1) % 3);
  }

  function removeTile(hand, tile) {
    if (!Array.isArray(hand)) return false;
    let index = hand.indexOf(tile);
    if (index < 0) {
      const id = tile34(tile);
      index = hand.findIndex((item) => tile34(item) === id);
    }
    if (index < 0) return false;
    hand.splice(index, 1);
    return true;
  }

  return {
    tile34,
    tileName,
    isRed,
    counts34,
    shanten,
    improvingTiles,
    winningTiles,
    doraFromMarker,
    removeTile
  };
});
