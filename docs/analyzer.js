(function (root, factory) {
  const core = typeof module === "object" && module.exports
    ? require("./mahjong.js")
    : root.MahjongLuckCore;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LuckAnalyzer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
  "use strict";

  if (!core) throw new Error("MahjongLuckCore is required");

  const VERSION = 2;
  const CALCULATION_VERSION = 8;
  const EXPERIENCE_MIN_POOL = 30;
  const DEFENSE_MIN_POOL = 30;
  const THEORY_MIN_N = 20;
  const RIICHI_MIN_N = 10;
  const SEAT_NAMES = ["東家", "南家", "西家", "北家"];
  const METRIC_KEYS = [
    "deal", "rankDeal", "defense", "dora", "effective", "effective2", "effective1", "genbutsu", "genbutsu1", "genbutsuTenpai",
    "fuuroGenbutsu", "fuuroGenbutsu1", "fuuroGenbutsuTenpai", "wasteDraw", "riichiWin", "riichiDealIn",
    "riichiHitOpponent", "uraSelf", "opponentDora", "opponentRiichiWin", "uraOpponent",
    "selfTenpaiWin", "opponentTenpaiWin", "selfTenpaiEntry", "opponentTenpaiEntry", "initialDoraSelf", "initialYakuhai", "initialDoraOpponent",
    "otherWinAvoidLuck"
  ];

  function clampProbability(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const normalized = numeric > 1 ? numeric / 100 : numeric;
    return Math.min(1, Math.max(0, normalized));
  }

  function finiteNumbers(values) {
    return (values || []).filter((value) => value != null && value !== "").map(Number).filter(Number.isFinite);
  }

  function mean(values) {
    const valid = finiteNumbers(values);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  }

  function parseGameInfo(entry) {
    let source = entry?.game_info || {};
    if (typeof source === "string") {
      try { source = JSON.parse(source); } catch { source = {}; }
    }
    return source?.game_info || source || {};
  }

  function actionEquals(left, right) {
    if (!left || !right) return false;
    return ["type", "actor", "target", "pai"].every((key) => {
      if (left[key] == null && right[key] == null) return true;
      return String(left[key]) === String(right[key]);
    });
  }

  function actualDetail(entry) {
    return (entry?.details || []).find((item) => actionEquals(item.action, entry.actual)) || null;
  }

  function winProbability(entry) {
    if (Array.isArray(entry?.sl_outcome) && entry.sl_outcome.length >= 2) {
      return clampProbability(Number(entry.sl_outcome[0]) + Number(entry.sl_outcome[1]));
    }
    for (const value of [entry?.win_prob, entry?.winProbability, entry?.agari_prob, entry?.hora_prob]) {
      const normalized = clampProbability(value);
      if (normalized != null) return normalized;
    }
    return null;
  }

  function placementProbabilities(entry) {
    for (const values of [entry?.sl_placement, entry?.rank_prob]) {
      if (!Array.isArray(values) || values.length < 4) continue;
      const normalized = values.slice(0, 4).map(clampProbability);
      if (normalized.every((value) => value != null)) return normalized;
    }
    return null;
  }

  function dealInProbability(entry) {
    const detail = actualDetail(entry);
    for (const value of [detail?.houjuu_rate, detail?.deal_in_rate, detail?.dealInRate]) {
      const normalized = clampProbability(value);
      if (normalized != null) return normalized;
    }
    return null;
  }

  function heroWins(endStatus, hero) {
    return (endStatus || []).some((item) => item?.type === "hora" && Number(item.actor) === hero);
  }

  function heroDealsIn(endStatus, hero) {
    return (endStatus || []).some((item) =>
      item?.type === "hora" && Number(item.target) === hero && Number(item.actor) !== hero
    );
  }

  function outcomeProbabilities(entry) {
    if (!Array.isArray(entry?.sl_outcome) || entry.sl_outcome.length < 5) return null;
    const probabilities = entry.sl_outcome.slice(0, 5).map(clampProbability);
    if (probabilities.some((value) => value == null)) return null;
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    return total > 0 ? probabilities : null;
  }

  function outcomeExposures(entry, endStatus, hero) {
    const p = outcomeProbabilities(entry);
    if (!p) return null;
    const wins = (endStatus || []).filter((item) => item?.type === "hora");
    const selfTsumo = wins.some((item) => Number(item.actor) === hero && Number(item.target) === hero);
    const selfRon = wins.some((item) => Number(item.actor) === hero && Number(item.target) !== hero);
    const dealtIn = wins.some((item) => Number(item.target) === hero && Number(item.actor) !== hero);
    const category = selfTsumo ? "tsumo" : selfRon ? "ron" : dealtIn ? "dealIn" : wins.length ? "other" : "draw";
    return {
      otherWinAvoidLuck: [{ p: p[3], y: category === "other" ? 1 : 0 }]
    };
  }

  function roundLabel(kyoku, index) {
    const value = Number(kyoku?.kyoku);
    if (!Number.isFinite(value)) return `第${index + 1}局`;
    const winds = ["東", "南", "西", "北"];
    const wind = winds[Math.floor(value / 4)] || "?";
    const honba = Number(kyoku?.honba || 0);
    return `${wind}${value % 4 + 1}局${honba ? `${honba}本場` : ""}`;
  }

  function unwrapPayload(payload) {
    if (typeof payload === "string") payload = JSON.parse(payload);
    if (payload?.review?.kyokus) return payload;
    if (payload?.data?.review?.kyokus) return payload.data;
    if (payload?.result?.review?.kyokus) return payload.result;
    throw new Error("BigCoachの解析JSONを認識できません。review.kyokus を含むJSONを読み込んでください。");
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function gameSignature(data) {
    const explicit = [data?.paipu_id, data?.paipuId, data?.game_id, data?.gameId, data?.uuid]
      .find((value) => value != null && String(value).trim());
    if (explicit != null) return `id:${String(explicit).trim()}`;
    if (Array.isArray(data?.mjai_log) && data.mjai_log.length) return `mjai:${JSON.stringify(data.mjai_log)}`;
    if (Array.isArray(data?.split_logs) && data.split_logs.length) return `split:${JSON.stringify(data.split_logs)}`;
    return `rounds:${JSON.stringify(data?.review?.kyokus || [])}`;
  }

  function splitMjaiRounds(log) {
    const rounds = [];
    let current = null;
    for (const event of Array.isArray(log) ? log : []) {
      if (event?.type === "start_kyoku") {
        if (current?.length) rounds.push(current);
        current = [event];
      } else if (current) {
        current.push(event);
        if (event?.type === "end_kyoku") {
          rounds.push(current);
          current = null;
        }
      }
    }
    if (current?.length) rounds.push(current);
    return rounds;
  }

  function inferRedTotals(data) {
    const rule = data?.split_logs?.[0]?.rule || {};
    const fields = ["aka51", "aka52", "aka53"];
    if (fields.some((field) => rule[field] != null)) {
      return fields.map((field) => Math.max(0, Number(rule[field]) || 0));
    }
    const text = JSON.stringify(data?.mjai_log || []);
    return ["m", "p", "s"].map((suit) => text.includes(`5${suit}r`) ? 1 : 0);
  }

  function eligibleDefense(entry, hero) {
    const info = parseGameInfo(entry);
    const riichi = Array.isArray(info?.riichi) ? info.riichi : [];
    const underRiichi = riichi.some((item) =>
      Number(item?.player_id) !== hero && (item?.accepted === true || item?.declared === true)
    );
    const hands = Array.isArray(info?.other_hands) ? info.other_hands : [];
    const underTwoMelds = hands.some((item) =>
      Number(item?.player_id) !== hero && Array.isArray(item?.open_sets) && item.open_sets.length >= 2
    );
    if (underRiichi && underTwoMelds) return "被リーチ・2副露";
    if (underRiichi) return "被リーチ";
    if (underTwoMelds) return "被2副露";
    return null;
  }

  function analyzeDefense(kyoku, hero) {
    const entries = Array.isArray(kyoku?.entries) ? kyoku.entries : [];
    const endStatus = Array.isArray(kyoku?.end_status) ? kyoku.end_status : [];
    const didDealIn = heroDealsIn(endStatus, hero);
    const lastDiscard = entries.reduce((last, entry, index) => entry?.actual?.type === "dahai" ? index : last, -1);
    return entries.map((entry, index) => {
      if (entry?.actual?.type !== "dahai") return null;
      const reason = eligibleDefense(entry, hero);
      const p = dealInProbability(entry);
      if (!reason || p == null) return null;
      return {
        p,
        y: didDealIn && index === lastDiscard ? 1 : 0,
        turn: Number(entry?.junme || 0),
        reason
      };
    }).filter(Boolean);
  }

  function remainingCounts(outside) {
    return outside.map((value) => Math.max(0, 4 - value));
  }

  function countIds(remaining, ids) {
    return [...new Set(ids || [])].reduce((sum, id) => sum + Number(remaining[id] || 0), 0);
  }

  function suitIndex(tile) {
    const match = String(tile || "").match(/^5([mps])r$/);
    return match ? (match[1] === "m" ? 0 : match[1] === "p" ? 1 : 2) : -1;
  }

  function analyzeMjaiRound(events, hero, redTotals, context) {
    const start = events?.[0];
    if (start?.type !== "start_kyoku" || !Array.isArray(start.tehais)) {
      return {
        supported: false, dora: [], effective: [], effective2: [], effective1: [], genbutsu: [], genbutsu1: [], genbutsuTenpai: [],
        fuuroGenbutsu: [], fuuroGenbutsu1: [], fuuroGenbutsuTenpai: [], wasteDraw: [], riichiWin: [], riichiDealIn: [],
        riichiHitOpponent: [], uraSelf: [], opponentDora: [], opponentRiichiWin: [], uraOpponent: [],
        selfTenpaiWin: [], opponentTenpaiWin: [], selfTenpaiEntry: [], opponentTenpaiEntry: [], initialDoraSelf: [], initialYakuhai: [], initialDoraOpponent: [], seat: null
      };
    }
    const hands = start.tehais.map((hand) => Array.isArray(hand) ? [...hand] : []);
    const playerCount = hands.length;
    const openMelds = Array(playerCount).fill(0);
    const outside = Array(34).fill(0);
    const redOutside = [0, 0, 0];
    const doraMarkers = start.dora_marker ? [start.dora_marker] : [];
    const acceptedRiichi = new Set();
    const discards = Array.from({ length: playerCount }, () => new Set());
    const pending = Array(playerCount).fill(null);
    const meldTiles = Array.from({ length: playerCount }, () => []);
    let lastDiscardTile = null;
    const seatIndex = ((hero - Number(start.oya || 0)) % playerCount + playerCount) % playerCount;
    const seat = SEAT_NAMES[seatIndex] || `席${seatIndex + 1}`;
    const baseMeta = { gameId: context.gameId, roundKey: context.roundKey, seat };
    const result = {
      supported: true, dora: [], effective: [], effective2: [], effective1: [], genbutsu: [], genbutsu1: [], genbutsuTenpai: [],
      fuuroGenbutsu: [], fuuroGenbutsu1: [], fuuroGenbutsuTenpai: [], wasteDraw: [], riichiWin: [], riichiDealIn: [],
      riichiHitOpponent: [], uraSelf: [], opponentDora: [], opponentRiichiWin: [], uraOpponent: [],
      selfTenpaiWin: [], opponentTenpaiWin: [], selfTenpaiEntry: [], opponentTenpaiEntry: [], initialDoraSelf: [], initialYakuhai: [], initialDoraOpponent: [], seat
    };

    function addOutside(tile) {
      const id = core.tile34(tile);
      if (id >= 0) outside[id] += 1;
      const suit = suitIndex(tile);
      if (suit >= 0) redOutside[suit] += 1;
    }

    for (const hand of hands) for (const tile of hand) addOutside(tile);
    for (const marker of doraMarkers) addOutside(marker);

    function poolState() {
      const remaining = remainingCounts(outside);
      return { remaining, total: remaining.reduce((sum, value) => sum + value, 0) };
    }

    function exposure(p, y, extra = {}) {
      return { p, y, ...baseMeta, ...extra };
    }

    function doraDrawExposure(state, actualId, tile) {
      const doraIds = doraMarkers.map(core.doraFromMarker).filter((id) => id >= 0);
      let copies = countIds(state.remaining, doraIds);
      const doraSet = new Set(doraIds);
      [4, 13, 22].forEach((id, suit) => {
        if (!doraSet.has(id)) copies += Math.max(0, Number(redTotals[suit] || 0) - redOutside[suit]);
      });
      return { p: copies / state.total, y: doraSet.has(actualId) || core.isRed(tile) ? 1 : 0 };
    }

    function hasPermanentFuriten(player, waits) {
      return waits.some((id) => discards[player].has(id));
    }

    function commonDiscardIds(players) {
      if (!players.length) return [];
      let common = new Set(discards[players[0]] || []);
      for (const player of players.slice(1)) {
        common = new Set([...common].filter((id) => discards[player].has(id)));
      }
      return [...common];
    }

    function wasteTileIds() {
      const ids = new Set();
      for (const discarded of discards[hero]) {
        ids.add(discarded);
        if (discarded >= 27) continue;
        const rank = discarded % 9;
        if (rank > 0) ids.add(discarded - 1);
        if (rank < 8) ids.add(discarded + 1);
      }
      return [...ids];
    }

    function initialDoraExposure(tiles) {
      const doraIds = new Set(doraMarkers.map(core.doraFromMarker).filter((id) => id >= 0));
      const populationById = Array.from({ length: 34 }, (_, id) => {
        const redCount = [4, 13, 22].indexOf(id);
        const reds = redCount >= 0 ? Number(redTotals[redCount] || 0) : 0;
        return Array.from({ length: 4 }, (_, copy) => (doraIds.has(id) ? 1 : 0) + (copy < reds ? 1 : 0));
      });
      for (const marker of doraMarkers) {
        const id = core.tile34(marker);
        if (id < 0 || !populationById[id]?.length) continue;
        const desiredRed = core.isRed(marker) ? 1 : 0;
        const base = doraIds.has(id) ? 1 : 0;
        const index = populationById[id].findIndex((value) => value === base + desiredRed);
        populationById[id].splice(index >= 0 ? index : 0, 1);
      }
      const population = populationById.flat();
      const draws = Math.min(tiles.length, population.length);
      if (!draws || !population.length) return null;
      const populationMean = mean(population);
      const populationVariance = mean(population.map((value) => Math.pow(value - populationMean, 2)));
      const variance = population.length > 1
        ? draws * (population.length - draws) / (population.length - 1) * populationVariance
        : 0;
      const observed = tiles.reduce((sum, tile) => sum + (doraIds.has(core.tile34(tile)) ? 1 : 0) + (core.isRed(tile) ? 1 : 0), 0);
      return exposure(draws * populationMean, observed, { v: variance, tiles: draws });
    }

    function choose(n, k) {
      if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0;
      const size = Math.min(k, n - k);
      let value = 1;
      for (let index = 1; index <= size; index += 1) value = value * (n - size + index) / index;
      return value;
    }

    function initialYakuhaiExposure(tiles) {
      const roundWind = core.tile34(start.bakaze);
      const yakuhaiIds = [...new Set([31, 32, 33, 27 + seatIndex, roundWind].filter((id) => id >= 27 && id <= 33))];
      const markerCounts = core.counts34(doraMarkers);
      const population = 136 - doraMarkers.length;
      const draws = Math.min(tiles.length, population);
      const denominator = choose(population, draws);
      if (!draws || !denominator || !yakuhaiIds.length) return null;
      const available = Object.fromEntries(yakuhaiIds.map((id) => [id, Math.max(0, 4 - markerCounts[id])]));
      const pairProbability = (copies) => {
        let probability = 0;
        for (let count = 2; count <= Math.min(copies, draws); count += 1) {
          probability += choose(copies, count) * choose(population - copies, draws - count) / denominator;
        }
        return probability;
      };
      const probabilities = Object.fromEntries(yakuhaiIds.map((id) => [id, pairProbability(available[id])]));
      const expected = yakuhaiIds.reduce((sum, id) => sum + probabilities[id], 0);
      let variance = yakuhaiIds.reduce((sum, id) => sum + probabilities[id] * (1 - probabilities[id]), 0);
      for (let left = 0; left < yakuhaiIds.length; left += 1) {
        for (let right = left + 1; right < yakuhaiIds.length; right += 1) {
          const first = yakuhaiIds[left], second = yakuhaiIds[right];
          let joint = 0;
          for (let firstCount = 2; firstCount <= Math.min(available[first], draws); firstCount += 1) {
            for (let secondCount = 2; secondCount <= Math.min(available[second], draws - firstCount); secondCount += 1) {
              joint += choose(available[first], firstCount)
                * choose(available[second], secondCount)
                * choose(population - available[first] - available[second], draws - firstCount - secondCount)
                / denominator;
            }
          }
          variance += 2 * (joint - probabilities[first] * probabilities[second]);
        }
      }
      const handCounts = core.counts34(tiles);
      const observed = yakuhaiIds.filter((id) => handCounts[id] >= 2).length;
      return exposure(expected, observed, { v: Math.max(0, variance), tiles: draws, yakuhaiTypes: yakuhaiIds.length });
    }

    function uraExposure(event) {
      const markers = Array.isArray(event?.ura_markers) ? event.ura_markers : [];
      const actor = Number(event?.actor);
      if (!markers.length || !acceptedRiichi.has(actor)) return null;
      const target = Number(event?.target);
      const winner = [...(hands[actor] || []), ...(meldTiles[actor] || [])];
      if (target !== actor && lastDiscardTile) winner.push(lastDiscardTile);
      const winnerCounts = Array(34).fill(0);
      for (const tile of winner) {
        const id = core.tile34(tile);
        if (id >= 0) winnerCounts[id] += 1;
      }
      const state = poolState();
      const population = [];
      for (let markerId = 0; markerId < state.remaining.length; markerId += 1) {
        const value = winnerCounts[core.doraFromMarker(core.tileName(markerId))] || 0;
        for (let copy = 0; copy < state.remaining[markerId]; copy += 1) population.push(value);
      }
      if (!population.length) return null;
      const draws = Math.min(markers.length, population.length);
      const populationMean = mean(population);
      const populationVariance = mean(population.map((value) => Math.pow(value - populationMean, 2)));
      const variance = population.length > 1
        ? draws * (population.length - draws) / (population.length - 1) * populationVariance
        : 0;
      const observed = markers.reduce((sum, marker) => {
        const doraId = core.doraFromMarker(marker);
        return sum + Number(winnerCounts[doraId] || 0);
      }, 0);
      return exposure(draws * populationMean, observed, { v: variance, markers: draws });
    }

    const selfInitialDora = initialDoraExposure(hands[hero] || []);
    const selfInitialYakuhai = initialYakuhaiExposure(hands[hero] || []);
    const opponentInitialDora = initialDoraExposure(hands.flatMap((hand, player) => player === hero ? [] : hand));
    if (selfInitialDora) result.initialDoraSelf.push(selfInitialDora);
    if (selfInitialYakuhai) result.initialYakuhai.push(selfInitialYakuhai);
    if (opponentInitialDora) result.initialDoraOpponent.push(opponentInitialDora);

    for (const event of events.slice(1)) {
      const actor = Number(event?.actor);
      if (event?.type === "tsumo" && actor >= 0 && actor < playerCount) {
        const state = poolState();
        const actualId = core.tile34(event.pai);
        if (state.total > 0) {
          const doraDraw = doraDrawExposure(state, actualId, event.pai);
          const improving = core.improvingTiles(hands[hero], openMelds[hero]);
          if (actor === hero) {
            const heroShanten = core.shanten(hands[hero], openMelds[hero]);
            const effectiveExposure = exposure(countIds(state.remaining, improving) / state.total, improving.includes(actualId) ? 1 : 0);
            result.dora.push(exposure(doraDraw.p, doraDraw.y));
            result.effective.push(effectiveExposure);
            if (heroShanten === 2) result.effective2.push(effectiveExposure);
            if (heroShanten === 1) result.effective1.push(effectiveExposure);
            if (heroShanten === 1) result.selfTenpaiEntry.push(exposure(countIds(state.remaining, improving) / state.total, improving.includes(actualId) ? 1 : 0));
            if (heroShanten === 0) {
              const waits = core.winningTiles(hands[hero], openMelds[hero]);
              if (waits.length && !hasPermanentFuriten(hero, waits)) result.selfTenpaiWin.push(exposure(countIds(state.remaining, waits) / state.total, waits.includes(actualId) ? 1 : 0));
            }

            const wasteIds = wasteTileIds();
            if (wasteIds.length) {
              result.wasteDraw.push(exposure(countIds(state.remaining, wasteIds) / state.total, wasteIds.includes(actualId) ? 1 : 0, { discardedTypes: discards[hero].size }));
            }

            const riichiOpponents = [...acceptedRiichi].filter((player) => player !== hero);
            if (riichiOpponents.length) {
              const ids = commonDiscardIds(riichiOpponents);
              const item = exposure(countIds(state.remaining, ids) / state.total, ids.includes(actualId) ? 1 : 0, { opponents: riichiOpponents.length });
              result.genbutsu.push(item);
              if (heroShanten === 1) result.genbutsu1.push(item);
              if (heroShanten === 0) result.genbutsuTenpai.push(item);
            }

            const fuuroOpponents = openMelds.map((melds, player) => ({ melds, player }))
              .filter((item) => item.player !== hero && item.melds > 0)
              .map((item) => item.player);
            if (fuuroOpponents.length) {
              const ids = commonDiscardIds(fuuroOpponents);
              const item = exposure(countIds(state.remaining, ids) / state.total, ids.includes(actualId) ? 1 : 0, { opponents: fuuroOpponents.length });
              result.fuuroGenbutsu.push(item);
              if (heroShanten === 1) result.fuuroGenbutsu1.push(item);
              if (heroShanten === 0) result.fuuroGenbutsuTenpai.push(item);
            }
          } else {
            result.opponentDora.push(exposure(doraDraw.p, doraDraw.y, { actor }));
            const opponentShanten = core.shanten(hands[actor], openMelds[actor]);
            if (opponentShanten === 1) {
              const opponentImproving = core.improvingTiles(hands[actor], openMelds[actor]);
              result.opponentTenpaiEntry.push(exposure(countIds(state.remaining, opponentImproving) / state.total, opponentImproving.includes(actualId) ? 1 : 0, { actor }));
            }
            if (opponentShanten === 0) {
              const waits = core.winningTiles(hands[actor], openMelds[actor]);
              if (waits.length && !hasPermanentFuriten(actor, waits)) result.opponentTenpaiWin.push(exposure(countIds(state.remaining, waits) / state.total, waits.includes(actualId) ? 1 : 0, { actor }));
            }
            if (acceptedRiichi.has(actor)) {
              const waits = core.winningTiles(hands[actor], openMelds[actor]);
              if (waits.length && !hasPermanentFuriten(actor, waits)) {
                result.opponentRiichiWin.push(exposure(countIds(state.remaining, waits) / state.total, waits.includes(actualId) ? 1 : 0, { actor }));
              }
            }
            if (acceptedRiichi.has(hero)) {
              const ownWaits = core.winningTiles(hands[hero], openMelds[hero]);
              if (ownWaits.length && !hasPermanentFuriten(hero, ownWaits)) {
                result.riichiHitOpponent.push(exposure(countIds(state.remaining, ownWaits) / state.total, ownWaits.includes(actualId) ? 1 : 0, { actor }));
                if (acceptedRiichi.has(actor)) {
                  pending[actor] = {
                    p: countIds(state.remaining, ownWaits) / state.total,
                    y: ownWaits.includes(actualId) ? 1 : 0,
                    ownWaits
                  };
                }
              }
            }
          }

          if (actor === hero && acceptedRiichi.has(hero)) {
            const ownWaits = core.winningTiles(hands[hero], openMelds[hero]);
            result.riichiWin.push(exposure(countIds(state.remaining, ownWaits) / state.total, ownWaits.includes(actualId) ? 1 : 0, { source: "ツモ" }));

            const opponentWaits = new Set();
            for (let player = 0; player < playerCount; player += 1) {
              if (player === hero || core.shanten(hands[player], openMelds[player]) !== 0) continue;
              const waits = core.winningTiles(hands[player], openMelds[player]);
              if (waits.some((id) => discards[player].has(id))) continue;
              for (const id of waits) opponentWaits.add(id);
            }
            for (const id of ownWaits) opponentWaits.delete(id);
            const ids = [...opponentWaits];
            if (ids.length) {
              result.riichiDealIn.push(exposure(countIds(state.remaining, ids) / state.total, ids.includes(actualId) ? 1 : 0, { opponentsTenpai: true }));
            }
          }
        }
        addOutside(event.pai);
        hands[actor].push(event.pai);
        lastDiscardTile = null;
        if (!pending[actor]) pending[actor] = { tile: event.pai };
        else pending[actor].tile = event.pai;
        continue;
      }

      if (event?.type === "dahai" && actor >= 0 && actor < playerCount) {
        if (actor !== hero && pending[actor]?.ownWaits && event.tsumogiri !== false) {
          const furiten = pending[actor].ownWaits.some((id) => discards[hero].has(id));
          if (!furiten) result.riichiWin.push(exposure(pending[actor].p, pending[actor].y, { source: "相手リーチ者のツモ切り" }));
        }
        core.removeTile(hands[actor], event.pai);
        const id = core.tile34(event.pai);
        if (id >= 0) discards[actor].add(id);
        lastDiscardTile = event.pai;
        pending[actor] = null;
        continue;
      }

      if (event?.type === "reach_accepted" && actor >= 0) {
        acceptedRiichi.add(actor);
        continue;
      }

      if (event?.type === "dora" && event.dora_marker) {
        doraMarkers.push(event.dora_marker);
        addOutside(event.dora_marker);
        continue;
      }

      if (["chi", "pon", "daiminkan"].includes(event?.type) && actor >= 0 && actor < playerCount) {
        for (const tile of event.consumed || []) core.removeTile(hands[actor], tile);
        meldTiles[actor].push(...(event.consumed || []));
        if (event.pai) meldTiles[actor].push(event.pai);
        openMelds[actor] += 1;
        pending[actor] = null;
        continue;
      }

      if (event?.type === "ankan" && actor >= 0 && actor < playerCount) {
        for (const tile of event.consumed || []) core.removeTile(hands[actor], tile);
        meldTiles[actor].push(...(event.consumed || []));
        openMelds[actor] += 1;
        pending[actor] = null;
        continue;
      }

      if (event?.type === "kakan" && actor >= 0 && actor < playerCount) {
        for (const tile of event.consumed || []) core.removeTile(hands[actor], tile);
        if (event.pai) core.removeTile(hands[actor], event.pai);
        if (event.pai) meldTiles[actor].push(event.pai);
        pending[actor] = null;
        continue;
      }

      if (event?.type === "hora") {
        const ura = uraExposure(event);
        if (ura) result[Number(event.actor) === hero ? "uraSelf" : "uraOpponent"].push(ura);
      }

      if (["hora", "ryukyoku", "end_kyoku"].includes(event?.type)) {
        for (let index = 0; index < pending.length; index += 1) pending[index] = null;
      }
    }
    return result;
  }

  function finalPlacement(data, hero) {
    let scores = null;
    for (const event of Array.isArray(data?.mjai_log) ? data.mjai_log : []) {
      if (event?.type === "start_kyoku" && Array.isArray(event.scores)) {
        scores = event.scores.map(Number);
      } else if (scores && Array.isArray(event?.deltas) && event.deltas.length === scores.length) {
        scores = scores.map((score, index) => score + Number(event.deltas[index] || 0));
      }
    }
    if (!scores || !Number.isFinite(scores[hero])) return { actualRank: null, finalScore: null };
    const heroScore = scores[hero];
    const actualRank = 1 + scores.filter((score, index) => score > heroScore || (score === heroScore && index < hero)).length;
    return { actualRank, finalScore: heroScore };
  }

  function analyzePayload(payload, meta = {}) {
    const data = unwrapPayload(payload);
    const kyokus = Array.isArray(data.review?.kyokus) ? data.review.kyokus : [];
    if (!kyokus.length) throw new Error("解析できる局データがありません。");
    const hero = Number.isFinite(Number(data.player_id)) ? Number(data.player_id) : 0;
    const sourceSignature = gameSignature(data);
    const gameId = `bc-game-${hashText(sourceSignature)}-${sourceSignature.length.toString(36)}`;
    const mjaiRounds = splitMjaiRounds(data.mjai_log);
    const redTotals = inferRedTotals(data);
    const rounds = kyokus.map((kyoku, index) => {
      const entries = Array.isArray(kyoku.entries) ? kyoku.entries : [];
      const firstEntry = entries.find((entry) => winProbability(entry) != null) || null;
      const outcomeEntry = entries.find((entry) => outcomeProbabilities(entry) != null) || null;
      const dealP = firstEntry ? winProbability(firstEntry) : null;
      const placement = firstEntry ? placementProbabilities(firstEntry) : null;
      const info = firstEntry ? parseGameInfo(firstEntry) : {};
      const currentRank = Number(info?.rank);
      const expectedRank = placement ? placement.reduce((sum, p, rank) => sum + p * (rank + 1), 0) : null;
      const theory = analyzeMjaiRound(mjaiRounds[index], hero, redTotals, {
        gameId,
        roundKey: `${gameId}:${index}`
      });
      const outcomes = outcomeExposures(outcomeEntry, kyoku.end_status || [], hero) || {
        otherWinAvoidLuck: []
      };
      return {
        label: roundLabel(kyoku, index),
        index,
        seat: theory.seat,
        deal: dealP == null ? null : { value: dealP, won: heroWins(kyoku.end_status || [], hero) ? 1 : 0 },
        rankDeal: expectedRank == null || !Number.isFinite(currentRank) ? null : {
          current: currentRank,
          expected: expectedRank,
          value: currentRank - expectedRank
        },
        defense: analyzeDefense(kyoku, hero),
        dora: theory.dora,
        effective: theory.effective,
        effective2: theory.effective2,
        effective1: theory.effective1,
        genbutsu: theory.genbutsu,
        genbutsu1: theory.genbutsu1,
        genbutsuTenpai: theory.genbutsuTenpai,
        fuuroGenbutsu: theory.fuuroGenbutsu,
        fuuroGenbutsu1: theory.fuuroGenbutsu1,
        fuuroGenbutsuTenpai: theory.fuuroGenbutsuTenpai,
        wasteDraw: theory.wasteDraw,
        riichiWin: theory.riichiWin,
        riichiDealIn: theory.riichiDealIn,
        riichiHitOpponent: theory.riichiHitOpponent,
        uraSelf: theory.uraSelf,
        opponentDora: theory.opponentDora,
        opponentRiichiWin: theory.opponentRiichiWin,
        uraOpponent: theory.uraOpponent,
        selfTenpaiWin: theory.selfTenpaiWin,
        opponentTenpaiWin: theory.opponentTenpaiWin,
        selfTenpaiEntry: theory.selfTenpaiEntry,
        opponentTenpaiEntry: theory.opponentTenpaiEntry,
        initialDoraSelf: theory.initialDoraSelf,
        initialYakuhai: theory.initialYakuhai,
        initialDoraOpponent: theory.initialDoraOpponent,
        ...outcomes,
        theorySupported: theory.supported
      };
    });
    const signature = JSON.stringify(rounds);
    const startGame = (data.mjai_log || []).find((event) => event?.type === "start_game");
    const rawNames = Array.isArray(startGame?.names)
      ? startGame.names
      : Array.isArray(data.split_logs?.[0]?.name) ? data.split_logs[0].name : [];
    const players = rawNames.slice(0, 4).map((name) => String(name || "").trim());
    const heroName = String(meta.playerName || players[hero] || "").trim();
    const placement = finalPlacement(data, hero);
    return {
      schemaVersion: VERSION,
      calculationVersion: CALCULATION_VERSION,
      id: `bc-${hashText(signature)}`,
      gameId,
      taskId: String(meta.taskId || ""),
      sourceUrl: meta.sourceUrl || "",
      title: meta.title || `BigCoach解析 ${kyokus.length}局`,
      importedAt: meta.importedAt || new Date().toISOString(),
      engine: String(data.engine || "BigCoach"),
      gameLength: String(data.game_length || ""),
      platform: String(meta.platform || ""),
      table: String(meta.table || data.split_logs?.[0]?.rule?.disp || ""),
      heroName,
      actualRank: placement.actualRank,
      finalScore: placement.finalScore,
      players,
      opponents: players.filter((name, index) => index !== hero && name),
      rounds
    };
  }

  function empiricalPercentile(value, pool) {
    const valid = finiteNumbers(pool).sort((a, b) => a - b);
    if (value == null || value === "" || !Number.isFinite(Number(value)) || !valid.length) return null;
    const numeric = Number(value);
    const lower = valid.filter((item) => item < numeric).length;
    const equal = valid.filter((item) => item === numeric).length;
    return ((lower + equal * 0.5) / valid.length) * 100;
  }

  function seededRandom(seedText) {
    let seed = 2166136261;
    for (const char of String(seedText)) {
      seed ^= char.charCodeAt(0);
      seed = Math.imul(seed, 16777619);
    }
    return function random() {
      seed |= 0;
      seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function bootstrapPercentile(subject, pool, seed = "bootstrap") {
    const values = finiteNumbers(subject);
    const reference = finiteNumbers(pool);
    if (!values.length || !reference.length) return null;
    const observed = mean(values);
    const random = seededRandom(`${seed}:${values.length}:${reference.length}`);
    const samples = [];
    const iterations = 999;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let sum = 0;
      for (let index = 0; index < values.length; index += 1) {
        sum += reference[Math.floor(random() * reference.length)];
      }
      samples.push(sum / values.length);
    }
    return empiricalPercentile(observed, samples);
  }

  function normalCdf(value) {
    const x = Number(value);
    if (!Number.isFinite(x)) return null;
    const sign = x < 0 ? -1 : 1;
    const scaled = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * scaled);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-scaled * scaled);
    return 0.5 * (1 + sign * erf);
  }

  function martingale(events, luckyDirection = 1) {
    const valid = (events || []).filter((event) => event && event.p != null && Number.isFinite(Number(event.y)));
    const observed = valid.reduce((sum, event) => sum + Number(event.y), 0);
    const expected = valid.reduce((sum, event) => sum + Number(event.p), 0);
    const variance = valid.reduce((sum, event) => {
      const supplied = Number(event.v);
      return sum + (Number.isFinite(supplied) && supplied >= 0 ? supplied : Number(event.p) * (1 - Number(event.p)));
    }, 0);
    const rawZ = variance > 0 ? (observed - expected) / Math.sqrt(variance) : null;
    const luckZ = rawZ == null ? null : rawZ * luckyDirection;
    const u = luckZ == null ? null : normalCdf(luckZ);
    return {
      n: valid.length,
      observed,
      expected,
      variance,
      rawZ,
      luckZ,
      u,
      percentile: u == null ? null : u * 100,
      pValue: rawZ == null ? null : Math.min(1, 2 * (1 - normalCdf(Math.abs(rawZ))))
    };
  }

  function pearson(left, right) {
    const pairs = (left || []).map((value, index) => [Number(value), Number(right?.[index])])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pairs.length < 3) return null;
    const leftMean = mean(pairs.map(([x]) => x));
    const rightMean = mean(pairs.map(([, y]) => y));
    const numerator = pairs.reduce((sum, [x, y]) => sum + (x - leftMean) * (y - rightMean), 0);
    const leftVariance = pairs.reduce((sum, [x]) => sum + Math.pow(x - leftMean, 2), 0);
    const rightVariance = pairs.reduce((sum, [, y]) => sum + Math.pow(y - rightMean, 2), 0);
    return leftVariance > 0 && rightVariance > 0 ? numerator / Math.sqrt(leftVariance * rightVariance) : null;
  }

  function rawUnitScores(rounds) {
    const validRounds = rounds || [];
    return {
      deal: mean(validRounds.map((round) => round.deal?.value)),
      rankDeal: mean(validRounds.map((round) => round.rankDeal?.value)),
      defense: mean(validRounds.map(defenseRoundValue)),
      dora: martingale(validRounds.flatMap((round) => round.dora || []), 1).percentile,
      effective: martingale(validRounds.flatMap((round) => round.effective || []), 1).percentile,
      effective2: martingale(validRounds.flatMap((round) => round.effective2 || []), 1).percentile,
      effective1: martingale(validRounds.flatMap((round) => round.effective1 || []), 1).percentile,
      genbutsu: martingale(validRounds.flatMap((round) => round.genbutsu || []), 1).percentile,
      genbutsu1: martingale(validRounds.flatMap((round) => round.genbutsu1 || []), 1).percentile,
      genbutsuTenpai: martingale(validRounds.flatMap((round) => round.genbutsuTenpai || []), 1).percentile,
      fuuroGenbutsu: martingale(validRounds.flatMap((round) => round.fuuroGenbutsu || []), 1).percentile,
      fuuroGenbutsu1: martingale(validRounds.flatMap((round) => round.fuuroGenbutsu1 || []), 1).percentile,
      fuuroGenbutsuTenpai: martingale(validRounds.flatMap((round) => round.fuuroGenbutsuTenpai || []), 1).percentile,
      wasteDraw: martingale(validRounds.flatMap((round) => round.wasteDraw || []), -1).percentile,
      riichiWin: martingale(validRounds.flatMap((round) => round.riichiWin || []), 1).percentile,
      riichiDealIn: martingale(validRounds.flatMap((round) => round.riichiDealIn || []), -1).percentile,
      riichiHitOpponent: martingale(validRounds.flatMap((round) => round.riichiHitOpponent || []), 1).percentile,
      uraSelf: martingale(validRounds.flatMap((round) => round.uraSelf || []), 1).percentile,
      opponentDora: martingale(validRounds.flatMap((round) => round.opponentDora || []), -1).percentile,
      opponentRiichiWin: martingale(validRounds.flatMap((round) => round.opponentRiichiWin || []), -1).percentile,
      uraOpponent: martingale(validRounds.flatMap((round) => round.uraOpponent || []), -1).percentile,
      selfTenpaiWin: martingale(validRounds.flatMap((round) => round.selfTenpaiWin || []), 1).percentile,
      opponentTenpaiWin: martingale(validRounds.flatMap((round) => round.opponentTenpaiWin || []), -1).percentile,
      selfTenpaiEntry: martingale(validRounds.flatMap((round) => round.selfTenpaiEntry || []), 1).percentile,
      opponentTenpaiEntry: martingale(validRounds.flatMap((round) => round.opponentTenpaiEntry || []), -1).percentile,
      initialDoraSelf: martingale(validRounds.flatMap((round) => round.initialDoraSelf || []), 1).percentile,
      initialYakuhai: martingale(validRounds.flatMap((round) => round.initialYakuhai || []), 1).percentile,
      initialDoraOpponent: martingale(validRounds.flatMap((round) => round.initialDoraOpponent || []), -1).percentile,
      otherWinAvoidLuck: martingale(validRounds.flatMap((round) => round.otherWinAvoidLuck || []), -1).luckZ ?? 0
    };
  }

  function scoreUnits(units, referenceUnits = units) {
    const raw = units.map((unit) => rawUnitScores(unit.rounds || []));
    const referenceRaw = referenceUnits === units ? raw : referenceUnits.map((unit) => rawUnitScores(unit.rounds || []));
    const empiricalKeys = ["deal", "rankDeal", "defense", "otherWinAvoidLuck"];
    const pools = Object.fromEntries(empiricalKeys.map((key) => [key, referenceRaw.map((row) => row[key]).filter(Number.isFinite)]));
    return units.map((unit, index) => {
      const { rounds, ...meta } = unit;
      const scores = { ...raw[index] };
      for (const key of empiricalKeys) scores[key] = empiricalPercentile(raw[index][key], pools[key]);
      return {
        ...meta,
        scores
      };
    });
  }

  function recordUnits(records) {
    return (Array.isArray(records) ? records : []).map((record) => ({
      id: record.id,
      importedAt: record.importedAt,
      title: record.title,
      actualRank: record.actualRank != null && Number.isInteger(Number(record.actualRank)) ? Number(record.actualRank) : null,
      rounds: record.rounds || []
    }));
  }

  function recordMetricScores(records, referenceRecords = records) {
    const units = recordUnits(records);
    const referenceUnits = referenceRecords === records ? units : recordUnits(referenceRecords);
    return scoreUnits(units, referenceUnits);
  }

  function roundMetricScores(records) {
    const units = (Array.isArray(records) ? records : []).flatMap((record) => (record.rounds || []).map((round, index) => ({
      id: `${record.id}:${index}`,
      recordId: record.id,
      importedAt: record.importedAt,
      title: record.title,
      roundLabel: round.label || `第${index + 1}局`,
      actualRank: record.actualRank != null && Number.isInteger(Number(record.actualRank)) ? Number(record.actualRank) : null,
      rounds: [round]
    })));
    return scoreUnits(units);
  }

  function weightedMetricScore(scores, weights) {
    return METRIC_KEYS.reduce((sum, key) => sum + (Number.isFinite(scores?.[key]) ? scores[key] : 50) * Number(weights[key] || 0), 0);
  }

  function fitScoreRows(rows, ridgePenalty = 10) {
    const equalWeights = Object.fromEntries(METRIC_KEYS.map((key) => [key, 1 / METRIC_KEYS.length]));
    if (rows.length < 20) return { weights: equalWeights, correlation: null, sampleN: rows.length, fitted: false, ridgePenalty };

    const columns = METRIC_KEYS.map((key) => rows.map((row) => Number.isFinite(row.scores[key]) ? row.scores[key] : 50));
    const scales = [];
    const standardized = columns.map((values) => {
      const center = mean(values);
      const variance = mean(values.map((value) => Math.pow(value - center, 2)));
      const scale = variance > 0 ? Math.sqrt(variance) : 1;
      scales.push(scale);
      return values.map((value) => (value - center) / scale);
    });
    const outcome = rows.map((row) => 5 - row.actualRank);
    const outcomeMean = mean(outcome);
    const centeredOutcome = outcome.map((value) => value - outcomeMean);
    const beta = Array(METRIC_KEYS.length).fill(0);

    for (let iteration = 0; iteration < 500; iteration += 1) {
      let movement = 0;
      for (let feature = 0; feature < METRIC_KEYS.length; feature += 1) {
        let numerator = 0;
        let denominator = 0;
        for (let row = 0; row < rows.length; row += 1) {
          let residual = centeredOutcome[row];
          for (let other = 0; other < METRIC_KEYS.length; other += 1) {
            if (other !== feature) residual -= standardized[other][row] * beta[other];
          }
          numerator += standardized[feature][row] * residual;
          denominator += standardized[feature][row] * standardized[feature][row];
        }
        const next = denominator > 0 ? Math.max(0, numerator / (denominator + Math.max(0, Number(ridgePenalty) || 0))) : 0;
        movement = Math.max(movement, Math.abs(next - beta[feature]));
        beta[feature] = next;
      }
      if (movement < 1e-10) break;
    }

    const rawBeta = beta.map((value, index) => value / scales[index]);
    const total = rawBeta.reduce((sum, value) => sum + value, 0);
    const weights = total > 0
      ? Object.fromEntries(METRIC_KEYS.map((key, index) => [key, rawBeta[index] / total]))
      : equalWeights;
    const prediction = rows.map((row) => weightedMetricScore(row.scores, weights));
    return { weights, correlation: pearson(prediction, outcome), sampleN: rows.length, fitted: total > 0, ridgePenalty };
  }

  function fitOutcomeWeights(records) {
    const rankedRecords = (Array.isArray(records) ? records : []).filter((record) => {
      const rank = Number(record?.actualRank);
      return Number.isInteger(rank) && rank >= 1 && rank <= 4;
    });
    const rows = recordMetricScores(rankedRecords);
    const model = fitScoreRows(rows);
    if (!model.fitted || rows.length < 40) return { ...model, validationCorrelation: null, validationFolds: 0 };
    const folds = 5;
    const predictions = Array(rows.length).fill(null);
    for (let fold = 0; fold < folds; fold += 1) {
      const trainingRecords = rankedRecords.filter((_, index) => index % folds !== fold);
      const holdoutRecords = rankedRecords.filter((_, index) => index % folds === fold);
      const training = recordMetricScores(trainingRecords);
      const holdout = recordMetricScores(holdoutRecords, trainingRecords);
      const foldModel = fitScoreRows(training);
      let holdoutIndex = 0;
      rows.forEach((_, index) => {
        if (index % folds !== fold) return;
        predictions[index] = weightedMetricScore(holdout[holdoutIndex].scores, foldModel.weights);
        holdoutIndex += 1;
      });
    }
    return {
      ...model,
      validationCorrelation: pearson(predictions, rows.map((row) => 5 - row.actualRank)),
      validationFolds: folds
    };
  }

  function empiricalMetric(subjectValues, poolValues, minPool, seed) {
    const values = finiteNumbers(subjectValues);
    const pool = finiteNumbers(poolValues);
    const percentile = bootstrapPercentile(values, pool, seed);
    return {
      n: values.length,
      poolN: pool.length,
      value: mean(values),
      u: percentile == null ? null : percentile / 100,
      percentile,
      pValue: percentile == null ? null : Math.min(1, 2 * Math.min(percentile / 100, 1 - percentile / 100)),
      included: values.length > 0 && pool.length >= minPool,
      minimum: minPool
    };
  }

  function defenseRoundValue(round) {
    const events = round?.defense || [];
    if (!events.length) return null;
    return mean(events.map((event) => Number(event.p) - Number(event.y)));
  }

  function groupRoundEvents(records, key) {
    return (records || []).flatMap((record) => (record.rounds || []).flatMap((round) => round[key] || []));
  }

  function seatStatistic(rows, labels = null) {
    const groups = new Map();
    rows.forEach((row, index) => {
      const label = labels ? labels[index] : row.seat;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(row.value);
    });
    const overall = mean(rows.map((row) => row.value));
    return [...groups.values()].reduce((sum, values) => sum + values.length * Math.pow(mean(values) - overall, 2), 0);
  }

  function seatPermutationTest(rows) {
    const valid = rows.filter((row) => row.seat && Number.isFinite(row.value));
    if (valid.length < 16 || new Set(valid.map((row) => row.seat)).size < 3) return { pValue: null, n: valid.length };
    const observed = seatStatistic(valid);
    const random = seededRandom(`seat:${valid.map((row) => row.gameId).join(":")}`);
    let extreme = 1;
    const iterations = 999;
    const byGame = new Map();
    valid.forEach((row, index) => {
      if (!byGame.has(row.gameId)) byGame.set(row.gameId, []);
      byGame.get(row.gameId).push(index);
    });
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const labels = valid.map((row) => row.seat);
      for (const indices of byGame.values()) {
        const shuffled = indices.map((index) => labels[index]);
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const target = Math.floor(random() * (index + 1));
          [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
        }
        indices.forEach((original, index) => { labels[original] = shuffled[index]; });
      }
      if (seatStatistic(valid, labels) >= observed - 1e-12) extreme += 1;
    }
    return { pValue: extreme / (iterations + 1), n: valid.length };
  }

  function serialStatistic(byGame, shuffled = false, random = null) {
    const pairs = [];
    for (const valuesOriginal of byGame.values()) {
      const values = [...valuesOriginal];
      if (shuffled) {
        for (let index = values.length - 1; index > 0; index -= 1) {
          const target = Math.floor(random() * (index + 1));
          [values[index], values[target]] = [values[target], values[index]];
        }
      }
      for (let index = 1; index < values.length; index += 1) pairs.push([values[index - 1], values[index]]);
    }
    if (pairs.length < 3) return null;
    const leftMean = mean(pairs.map((pair) => pair[0]));
    const rightMean = mean(pairs.map((pair) => pair[1]));
    const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) * (pair[1] - rightMean), 0);
    const leftVar = pairs.reduce((sum, pair) => sum + Math.pow(pair[0] - leftMean, 2), 0);
    const rightVar = pairs.reduce((sum, pair) => sum + Math.pow(pair[1] - rightMean, 2), 0);
    return leftVar && rightVar ? numerator / Math.sqrt(leftVar * rightVar) : 0;
  }

  function serialPermutationTest(rows) {
    const byGame = new Map();
    for (const row of rows.filter((item) => Number.isFinite(item.value))) {
      if (!byGame.has(row.gameId)) byGame.set(row.gameId, []);
      byGame.get(row.gameId).push(row.value);
    }
    const pairs = [...byGame.values()].reduce((sum, values) => sum + Math.max(0, values.length - 1), 0);
    if (pairs < 12) return { pValue: null, n: pairs };
    const observed = Math.abs(serialStatistic(byGame));
    const random = seededRandom(`serial:${rows.length}:${pairs}`);
    let extreme = 1;
    const iterations = 999;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (Math.abs(serialStatistic(byGame, true, random)) >= observed - 1e-12) extreme += 1;
    }
    return { pValue: extreme / (iterations + 1), n: pairs };
  }

  function holmAdjust(tests) {
    const valid = tests.map((test, index) => ({ test, index })).filter((item) => Number.isFinite(item.test.pValue));
    valid.sort((a, b) => a.test.pValue - b.test.pValue);
    let running = 0;
    valid.forEach((item, rank) => {
      running = Math.max(running, Math.min(1, item.test.pValue * (valid.length - rank)));
      item.test.adjustedP = running;
    });
    tests.forEach((test) => { if (!Number.isFinite(test.adjustedP)) test.adjustedP = null; });
    return tests;
  }

  function cauchyCombine(pValues) {
    const valid = (pValues || []).map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 1);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];
    const statistic = valid.reduce((sum, value) => {
      const p = Math.min(1 - 1e-15, Math.max(1e-15, value));
      return sum + Math.tan((0.5 - p) * Math.PI);
    }, 0) / valid.length;
    return Math.min(1, Math.max(0, 0.5 - Math.atan(statistic) / Math.PI));
  }

  function roundRows(records, valueOf) {
    return (records || []).flatMap((record) => (record.rounds || []).map((round) => ({
      gameId: record.gameId || record.id,
      seat: round.seat,
      value: valueOf(round)
    }))).filter((row) => Number.isFinite(row.value));
  }

  function summarize(records, selectedId = null) {
    const allRecords = Array.isArray(records) ? records : [];
    const selected = selectedId ? allRecords.filter((record) => record.id === selectedId) : allRecords;
    const subjectRounds = selected.flatMap((record) => record.rounds || []);
    const poolRounds = allRecords.flatMap((record) => record.rounds || []);

    const deal = empiricalMetric(
      subjectRounds.map((round) => round.deal?.value),
      poolRounds.map((round) => round.deal?.value),
      EXPERIENCE_MIN_POOL,
      `deal:${selectedId || "all"}`
    );
    const rankDeal = empiricalMetric(
      subjectRounds.map((round) => round.rankDeal?.value),
      poolRounds.map((round) => round.rankDeal?.value),
      EXPERIENCE_MIN_POOL,
      `rank:${selectedId || "all"}`
    );
    const defense = empiricalMetric(
      subjectRounds.map(defenseRoundValue),
      poolRounds.map(defenseRoundValue),
      DEFENSE_MIN_POOL,
      `defense:${selectedId || "all"}`
    );
    defense.events = subjectRounds.flatMap((round) => round.defense || []).length;
    defense.observed = subjectRounds.flatMap((round) => round.defense || []).reduce((sum, event) => sum + event.y, 0);
    defense.predicted = subjectRounds.flatMap((round) => round.defense || []).reduce((sum, event) => sum + event.p, 0);

    const dora = martingale(groupRoundEvents(selected, "dora"), 1);
    const effective = martingale(groupRoundEvents(selected, "effective"), 1);
    const effective2 = martingale(groupRoundEvents(selected, "effective2"), 1);
    const effective1 = martingale(groupRoundEvents(selected, "effective1"), 1);
    const genbutsu = martingale(groupRoundEvents(selected, "genbutsu"), 1);
    const genbutsu1 = martingale(groupRoundEvents(selected, "genbutsu1"), 1);
    const genbutsuTenpai = martingale(groupRoundEvents(selected, "genbutsuTenpai"), 1);
    const fuuroGenbutsu = martingale(groupRoundEvents(selected, "fuuroGenbutsu"), 1);
    const fuuroGenbutsu1 = martingale(groupRoundEvents(selected, "fuuroGenbutsu1"), 1);
    const fuuroGenbutsuTenpai = martingale(groupRoundEvents(selected, "fuuroGenbutsuTenpai"), 1);
    const wasteDraw = martingale(groupRoundEvents(selected, "wasteDraw"), -1);
    const riichiWin = martingale(groupRoundEvents(selected, "riichiWin"), 1);
    const riichiDealIn = martingale(groupRoundEvents(selected, "riichiDealIn"), -1);
    const riichiHitOpponent = martingale(groupRoundEvents(selected, "riichiHitOpponent"), 1);
    const uraSelf = martingale(groupRoundEvents(selected, "uraSelf"), 1);
    const opponentDora = martingale(groupRoundEvents(selected, "opponentDora"), -1);
    const opponentRiichiWin = martingale(groupRoundEvents(selected, "opponentRiichiWin"), -1);
    const uraOpponent = martingale(groupRoundEvents(selected, "uraOpponent"), -1);
    const selfTenpaiWin = martingale(groupRoundEvents(selected, "selfTenpaiWin"), 1);
    const opponentTenpaiWin = martingale(groupRoundEvents(selected, "opponentTenpaiWin"), -1);
    const selfTenpaiEntry = martingale(groupRoundEvents(selected, "selfTenpaiEntry"), 1);
    const opponentTenpaiEntry = martingale(groupRoundEvents(selected, "opponentTenpaiEntry"), -1);
    const initialDoraSelf = martingale(groupRoundEvents(selected, "initialDoraSelf"), 1);
    const initialYakuhai = martingale(groupRoundEvents(selected, "initialYakuhai"), 1);
    const initialDoraOpponent = martingale(groupRoundEvents(selected, "initialDoraOpponent"), -1);
    const subjectRawScores = selected.map((record) => rawUnitScores(record.rounds || []));
    const poolRawScores = allRecords.map((record) => rawUnitScores(record.rounds || []));
    const experienceOutcomeMetric = (key) => empiricalMetric(
      subjectRawScores.map((row) => row[key]),
      poolRawScores.map((row) => row[key]),
      EXPERIENCE_MIN_POOL,
      `${key}:${selectedId || "all"}`
    );
    const otherWinAvoidLuck = experienceOutcomeMetric("otherWinAvoidLuck");

    const individual = [
      { key: "deal", label: "配牌和了率", score: deal.percentile, included: deal.included, reason: `経験分布 ${deal.poolN}/${deal.minimum}局` },
      { key: "rankDeal", label: "配牌時平着変動", score: rankDeal.percentile, included: rankDeal.included, reason: `経験分布 ${rankDeal.poolN}/${rankDeal.minimum}局` },
      { key: "defense", label: "放銃予実幅", score: defense.percentile, included: defense.included, reason: `経験分布 ${defense.poolN}/${defense.minimum}局` },
      { key: "dora", label: "ドラツモ", score: dora.percentile, included: dora.n >= THEORY_MIN_N, reason: `対象 ${dora.n}/${THEORY_MIN_N}ツモ` },
      { key: "effective", label: "有効牌ツモ", score: effective.percentile, included: effective.n >= THEORY_MIN_N, reason: `対象 ${effective.n}/${THEORY_MIN_N}ツモ` },
      { key: "effective2", label: "2シャンテン時有効牌", score: effective2.percentile, included: effective2.n >= THEORY_MIN_N, reason: `対象 ${effective2.n}/${THEORY_MIN_N}ツモ` },
      { key: "effective1", label: "1シャンテン時有効牌", score: effective1.percentile, included: effective1.n >= THEORY_MIN_N, reason: `対象 ${effective1.n}/${THEORY_MIN_N}ツモ` },
      { key: "genbutsu", label: "被リーチ時現物", score: genbutsu.percentile, included: genbutsu.n >= RIICHI_MIN_N, reason: `対象 ${genbutsu.n}/${RIICHI_MIN_N}ツモ` },
      { key: "genbutsu1", label: "被リーチ・1シャンテン時現物", score: genbutsu1.percentile, included: genbutsu1.n >= RIICHI_MIN_N, reason: `対象 ${genbutsu1.n}/${RIICHI_MIN_N}ツモ` },
      { key: "genbutsuTenpai", label: "被リーチ・聴牌時現物", score: genbutsuTenpai.percentile, included: genbutsuTenpai.n >= RIICHI_MIN_N, reason: `対象 ${genbutsuTenpai.n}/${RIICHI_MIN_N}ツモ` },
      { key: "fuuroGenbutsu", label: "被副露時現物", score: fuuroGenbutsu.percentile, included: fuuroGenbutsu.n >= RIICHI_MIN_N, reason: `対象 ${fuuroGenbutsu.n}/${RIICHI_MIN_N}ツモ` },
      { key: "fuuroGenbutsu1", label: "被副露・1シャンテン時現物", score: fuuroGenbutsu1.percentile, included: fuuroGenbutsu1.n >= RIICHI_MIN_N, reason: `対象 ${fuuroGenbutsu1.n}/${RIICHI_MIN_N}ツモ` },
      { key: "fuuroGenbutsuTenpai", label: "被副露・聴牌時現物", score: fuuroGenbutsuTenpai.percentile, included: fuuroGenbutsuTenpai.n >= RIICHI_MIN_N, reason: `対象 ${fuuroGenbutsuTenpai.n}/${RIICHI_MIN_N}ツモ` },
      { key: "wasteDraw", label: "無駄ツモ回避", score: wasteDraw.percentile, included: wasteDraw.n >= THEORY_MIN_N, reason: `対象 ${wasteDraw.n}/${THEORY_MIN_N}ツモ` },
      { key: "riichiWin", label: "リーチ時自明和了", score: riichiWin.percentile, included: riichiWin.n >= RIICHI_MIN_N, reason: `対象 ${riichiWin.n}/${RIICHI_MIN_N}機会` },
      { key: "riichiDealIn", label: "リーチ後危険牌回避", score: riichiDealIn.percentile, included: riichiDealIn.n >= RIICHI_MIN_N, reason: `対象 ${riichiDealIn.n}/${RIICHI_MIN_N}ツモ` },
      { key: "riichiHitOpponent", label: "リーチ時他家掴ませ", score: riichiHitOpponent.percentile, included: riichiHitOpponent.n >= RIICHI_MIN_N, reason: `対象 ${riichiHitOpponent.n}/${RIICHI_MIN_N}他家ツモ` },
      { key: "uraSelf", label: "自分裏ドラ", score: uraSelf.percentile, included: uraSelf.n >= RIICHI_MIN_N, reason: `対象 ${uraSelf.n}/${RIICHI_MIN_N}和了` },
      { key: "opponentDora", label: "他家ドラ回避", score: opponentDora.percentile, included: opponentDora.n >= THEORY_MIN_N, reason: `対象 ${opponentDora.n}/${THEORY_MIN_N}他家ツモ` },
      { key: "opponentRiichiWin", label: "他家リーチ和了回避", score: opponentRiichiWin.percentile, included: opponentRiichiWin.n >= RIICHI_MIN_N, reason: `対象 ${opponentRiichiWin.n}/${RIICHI_MIN_N}他家ツモ` },
      { key: "uraOpponent", label: "他家裏ドラ回避", score: uraOpponent.percentile, included: uraOpponent.n >= RIICHI_MIN_N, reason: `対象 ${uraOpponent.n}/${RIICHI_MIN_N}和了` },
      { key: "selfTenpaiWin", label: "テンパイ後和了牌ツモ", score: selfTenpaiWin.percentile, included: selfTenpaiWin.n >= RIICHI_MIN_N, reason: `対象 ${selfTenpaiWin.n}/${RIICHI_MIN_N}ツモ` },
      { key: "opponentTenpaiWin", label: "他家テンパイ和了回避", score: opponentTenpaiWin.percentile, included: opponentTenpaiWin.n >= RIICHI_MIN_N, reason: `対象 ${opponentTenpaiWin.n}/${RIICHI_MIN_N}他家ツモ` },
      { key: "selfTenpaiEntry", label: "テンパイ到達ツモ", score: selfTenpaiEntry.percentile, included: selfTenpaiEntry.n >= THEORY_MIN_N, reason: `対象 ${selfTenpaiEntry.n}/${THEORY_MIN_N}一向聴ツモ` },
      { key: "opponentTenpaiEntry", label: "他家テンパイ到達回避", score: opponentTenpaiEntry.percentile, included: opponentTenpaiEntry.n >= THEORY_MIN_N, reason: `対象 ${opponentTenpaiEntry.n}/${THEORY_MIN_N}他家一向聴ツモ` },
      { key: "initialDoraSelf", label: "配牌時ドラ枚数", score: initialDoraSelf.percentile, included: initialDoraSelf.n >= THEORY_MIN_N, reason: `対象 ${initialDoraSelf.n}/${THEORY_MIN_N}局` },
      { key: "initialYakuhai", label: "配牌時役牌対子・暗刻", score: initialYakuhai.percentile, included: initialYakuhai.n >= THEORY_MIN_N, reason: `対象 ${initialYakuhai.n}/${THEORY_MIN_N}局` },
      { key: "initialDoraOpponent", label: "他家配牌ドラ回避", score: initialDoraOpponent.percentile, included: initialDoraOpponent.n >= THEORY_MIN_N, reason: `対象 ${initialDoraOpponent.n}/${THEORY_MIN_N}局` },
      { key: "otherWinAvoidLuck", label: "他家決着回避上振れ", score: otherWinAvoidLuck.percentile, included: otherWinAvoidLuck.included, reason: `経験分布 ${otherWinAvoidLuck.poolN}/${otherWinAvoidLuck.minimum}対局` }
    ];
    const component = Object.fromEntries(individual.map((item) => [item.key, item]));
    const families = [
      { key: "initial", label: "配牌", items: [component.deal, component.rankDeal] },
      { key: "defense", label: "守備", items: [component.defense, component.genbutsu, component.genbutsu1, component.genbutsuTenpai, component.fuuroGenbutsu, component.fuuroGenbutsu1, component.fuuroGenbutsuTenpai] },
      { key: "draw", label: "自分の牌運", items: [component.initialDoraSelf, component.initialYakuhai, component.dora, component.effective, component.effective2, component.effective1, component.wasteDraw, component.selfTenpaiEntry, component.selfTenpaiWin] },
      { key: "riichi", label: "自分リーチ後", items: [component.riichiWin, component.riichiDealIn, component.riichiHitOpponent, component.uraSelf] },
      { key: "opponents", label: "他家の運", items: [component.initialDoraOpponent, component.opponentDora, component.opponentTenpaiEntry, component.opponentTenpaiWin, component.opponentRiichiWin, component.uraOpponent] },
      { key: "outcome", label: "他家の局結果", items: [component.otherWinAvoidLuck] }
    ].map((family) => {
      const included = family.items.filter((item) => item.included && Number.isFinite(item.score));
      return { ...family, included: included.length > 0, score: mean(included.map((item) => item.score)) };
    });
    const outcomeModel = fitOutcomeWeights(allRecords);
    const recordScores = recordMetricScores(allRecords);
    const overallPool = recordScores.map((row) => weightedMetricScore(row.scores, outcomeModel.weights));
    const selectedIds = new Set(selected.map((record) => record.id));
    const overallDistribution = empiricalMetric(
      recordScores.filter((row) => selectedIds.has(row.id)).map((row) => weightedMetricScore(row.scores, outcomeModel.weights)),
      overallPool,
      EXPERIENCE_MIN_POOL,
      `overall:${selectedId || "all"}`
    );
    const overallScore = overallDistribution.percentile;

    const effectiveRoundRows = roundRows(selected, (round) => martingale(round.effective || [], 1).luckZ);
    const seatTest = seatPermutationTest(effectiveRoundRows);
    const serialTest = serialPermutationTest(effectiveRoundRows);
    const dealRows = roundRows(selected, (round) => round.deal?.value);
    const rankRows = roundRows(selected, (round) => round.rankDeal?.value);
    const defenseRows = roundRows(selected, defenseRoundValue);
    const dealSeat = seatPermutationTest(dealRows);
    const dealSerial = serialPermutationTest(dealRows);
    const rankSeat = seatPermutationTest(rankRows);
    const rankSerial = serialPermutationTest(rankRows);
    const defenseSeat = seatPermutationTest(defenseRows);
    const defenseSerial = serialPermutationTest(defenseRows);

    const theoryDiagnostics = [
      { key: "doraCalibration", label: "ドラツモ：理論値との一致", pValue: dora.n >= THEORY_MIN_N ? dora.pValue : null, n: dora.n, method: "逐次確率残差" },
      { key: "effectiveCalibration", label: "有効牌：理論値との一致", pValue: effective.n >= THEORY_MIN_N ? effective.pValue : null, n: effective.n, method: "逐次確率残差" },
      { key: "effective2Calibration", label: "2シャンテン時有効牌：理論値との一致", pValue: effective2.n >= THEORY_MIN_N ? effective2.pValue : null, n: effective2.n, method: "逐次確率残差" },
      { key: "effective1Calibration", label: "1シャンテン時有効牌：理論値との一致", pValue: effective1.n >= THEORY_MIN_N ? effective1.pValue : null, n: effective1.n, method: "逐次確率残差" },
      { key: "genbutsuCalibration", label: "被リーチ時現物：理論値との一致", pValue: genbutsu.n >= RIICHI_MIN_N ? genbutsu.pValue : null, n: genbutsu.n, method: "逐次確率残差" },
      { key: "genbutsu1Calibration", label: "被リーチ・1シャンテン時現物：理論値との一致", pValue: genbutsu1.n >= RIICHI_MIN_N ? genbutsu1.pValue : null, n: genbutsu1.n, method: "逐次確率残差" },
      { key: "genbutsuTenpaiCalibration", label: "被リーチ・聴牌時現物：理論値との一致", pValue: genbutsuTenpai.n >= RIICHI_MIN_N ? genbutsuTenpai.pValue : null, n: genbutsuTenpai.n, method: "逐次確率残差" },
      { key: "fuuroGenbutsuCalibration", label: "被副露時現物：理論値との一致", pValue: fuuroGenbutsu.n >= RIICHI_MIN_N ? fuuroGenbutsu.pValue : null, n: fuuroGenbutsu.n, method: "逐次確率残差" },
      { key: "fuuroGenbutsu1Calibration", label: "被副露・1シャンテン時現物：理論値との一致", pValue: fuuroGenbutsu1.n >= RIICHI_MIN_N ? fuuroGenbutsu1.pValue : null, n: fuuroGenbutsu1.n, method: "逐次確率残差" },
      { key: "fuuroGenbutsuTenpaiCalibration", label: "被副露・聴牌時現物：理論値との一致", pValue: fuuroGenbutsuTenpai.n >= RIICHI_MIN_N ? fuuroGenbutsuTenpai.pValue : null, n: fuuroGenbutsuTenpai.n, method: "逐次確率残差" },
      { key: "wasteDrawCalibration", label: "無駄ツモ：理論値との一致", pValue: wasteDraw.n >= THEORY_MIN_N ? wasteDraw.pValue : null, n: wasteDraw.n, method: "逐次確率残差" },
      { key: "riichiWinCalibration", label: "リーチ和了牌：理論値との一致", pValue: riichiWin.n >= RIICHI_MIN_N ? riichiWin.pValue : null, n: riichiWin.n, method: "逐次確率残差" },
      { key: "riichiDangerCalibration", label: "リーチ後危険牌：理論値との一致", pValue: riichiDealIn.n >= RIICHI_MIN_N ? riichiDealIn.pValue : null, n: riichiDealIn.n, method: "逐次確率残差" },
      { key: "riichiHitOpponentCalibration", label: "リーチ時他家掴ませ：理論値との一致", pValue: riichiHitOpponent.n >= RIICHI_MIN_N ? riichiHitOpponent.pValue : null, n: riichiHitOpponent.n, method: "逐次確率残差" },
      { key: "uraSelfCalibration", label: "自分裏ドラ：理論値との一致", pValue: uraSelf.n >= RIICHI_MIN_N ? uraSelf.pValue : null, n: uraSelf.n, method: "有限母集団残差" },
      { key: "opponentDoraCalibration", label: "他家ドラ：理論値との一致", pValue: opponentDora.n >= THEORY_MIN_N ? opponentDora.pValue : null, n: opponentDora.n, method: "逐次確率残差" },
      { key: "opponentRiichiWinCalibration", label: "他家リーチ和了牌：理論値との一致", pValue: opponentRiichiWin.n >= RIICHI_MIN_N ? opponentRiichiWin.pValue : null, n: opponentRiichiWin.n, method: "逐次確率残差" },
      { key: "uraOpponentCalibration", label: "他家裏ドラ：理論値との一致", pValue: uraOpponent.n >= RIICHI_MIN_N ? uraOpponent.pValue : null, n: uraOpponent.n, method: "有限母集団残差" },
      { key: "selfTenpaiWinCalibration", label: "テンパイ後和了牌ツモ：理論値との一致", pValue: selfTenpaiWin.n >= RIICHI_MIN_N ? selfTenpaiWin.pValue : null, n: selfTenpaiWin.n, method: "逐次確率残差" },
      { key: "opponentTenpaiWinCalibration", label: "他家テンパイ和了牌：理論値との一致", pValue: opponentTenpaiWin.n >= RIICHI_MIN_N ? opponentTenpaiWin.pValue : null, n: opponentTenpaiWin.n, method: "逐次確率残差" },
      { key: "selfTenpaiEntryCalibration", label: "テンパイ到達ツモ：理論値との一致", pValue: selfTenpaiEntry.n >= THEORY_MIN_N ? selfTenpaiEntry.pValue : null, n: selfTenpaiEntry.n, method: "逐次確率残差" },
      { key: "opponentTenpaiEntryCalibration", label: "他家テンパイ到達：理論値との一致", pValue: opponentTenpaiEntry.n >= THEORY_MIN_N ? opponentTenpaiEntry.pValue : null, n: opponentTenpaiEntry.n, method: "逐次確率残差" },
      { key: "initialDoraSelfCalibration", label: "配牌時ドラ枚数：理論値との一致", pValue: initialDoraSelf.n >= THEORY_MIN_N ? initialDoraSelf.pValue : null, n: initialDoraSelf.n, method: "有限母集団残差" },
      { key: "initialYakuhaiCalibration", label: "配牌時役牌対子・暗刻：理論値との一致", pValue: initialYakuhai.n >= THEORY_MIN_N ? initialYakuhai.pValue : null, n: initialYakuhai.n, method: "有限母集団残差" },
      { key: "initialDoraOpponentCalibration", label: "他家配牌ドラ：理論値との一致", pValue: initialDoraOpponent.n >= THEORY_MIN_N ? initialDoraOpponent.pValue : null, n: initialDoraOpponent.n, method: "有限母集団残差" },
      { key: "seat", label: "有効牌残差 × 親からの席順", pValue: seatTest.pValue, n: seatTest.n, method: "半荘内置換検定" },
      { key: "serial", label: "有効牌残差の局間連続性", pValue: serialTest.pValue, n: serialTest.n, method: "半荘内順序置換" }
    ];
    const bigCoachDiagnostics = [
      { key: "dealFit", label: "配牌和了率：経験分布適合", pValue: deal.included ? deal.pValue : null, n: deal.n, method: "経験分布bootstrap" },
      { key: "rankFit", label: "配牌時平着変動：経験分布適合", pValue: rankDeal.included ? rankDeal.pValue : null, n: rankDeal.n, method: "経験分布bootstrap" },
      { key: "defenseFit", label: "放銃予実幅：経験分布適合", pValue: defense.included ? defense.pValue : null, n: defense.n, method: "経験分布bootstrap" },
      { key: "otherWinAvoidLuckFit", label: "他家決着回避残差：経験分布適合", pValue: otherWinAvoidLuck.included ? otherWinAvoidLuck.pValue : null, n: otherWinAvoidLuck.n, method: "BigCoach予測×経験分布" },
      { key: "dealSeat", label: "配牌和了率 × 親からの席順", pValue: dealSeat.pValue, n: dealSeat.n, method: "半荘内置換検定" },
      { key: "dealSerial", label: "配牌和了率の局間連続性", pValue: dealSerial.pValue, n: dealSerial.n, method: "半荘内順序置換" },
      { key: "rankSeat", label: "平着変動 × 親からの席順", pValue: rankSeat.pValue, n: rankSeat.n, method: "半荘内置換検定" },
      { key: "rankSerial", label: "平着変動の局間連続性", pValue: rankSerial.pValue, n: rankSerial.n, method: "半荘内順序置換" },
      { key: "defenseSeat", label: "放銃予実幅 × 親からの席順", pValue: defenseSeat.pValue, n: defenseSeat.n, method: "半荘内置換検定" },
      { key: "defenseSerial", label: "放銃予実幅の局間連続性", pValue: defenseSerial.pValue, n: defenseSerial.n, method: "半荘内順序置換" }
    ];
    const theoryP = cauchyCombine(theoryDiagnostics.map((test) => test.pValue));
    const bigCoachP = cauchyCombine(bigCoachDiagnostics.map((test) => test.pValue));
    const allP = Number.isFinite(theoryP) && Number.isFinite(bigCoachP)
      ? cauchyCombine([theoryP, bigCoachP])
      : null;
    const groupTests = holmAdjust([
      { key: "theory", label: "理論値系 総合検定", pValue: theoryP, n: theoryDiagnostics.filter((test) => Number.isFinite(test.pValue)).length, method: "Cauchy結合 + Holm補正" },
      { key: "bigcoach", label: "BigCoach依存系 総合検定", pValue: bigCoachP, n: bigCoachDiagnostics.filter((test) => Number.isFinite(test.pValue)).length, method: "Cauchy結合 + Holm補正" },
      { key: "all", label: "全指標 統合検定", pValue: allP, n: [theoryP, bigCoachP].filter(Number.isFinite).length, method: "2系統Cauchy結合 + Holm補正" }
    ]);
    const diagnostics = holmAdjust([...theoryDiagnostics, ...bigCoachDiagnostics]);

    return {
      records: selected.length,
      rounds: subjectRounds.length,
      deal,
      rankDeal,
      defense,
      dora,
      effective,
      effective2,
      effective1,
      genbutsu,
      genbutsu1,
      genbutsuTenpai,
      fuuroGenbutsu,
      fuuroGenbutsu1,
      fuuroGenbutsuTenpai,
      wasteDraw,
      riichiWin,
      riichiDealIn,
      riichiHitOpponent,
      uraSelf,
      opponentDora,
      opponentRiichiWin,
      uraOpponent,
      selfTenpaiWin,
      opponentTenpaiWin,
      selfTenpaiEntry,
      opponentTenpaiEntry,
      initialDoraSelf,
      initialYakuhai,
      initialDoraOpponent,
      otherWinAvoidLuck,
      overall: {
        score: overallScore,
        u: overallScore == null ? null : overallScore / 100,
        families,
        weights: outcomeModel.weights,
        correlation: outcomeModel.correlation,
        validationCorrelation: outcomeModel.validationCorrelation,
        validationFolds: outcomeModel.validationFolds,
        ridgePenalty: outcomeModel.ridgePenalty,
        correlationN: outcomeModel.sampleN,
        rawScore: overallDistribution.value,
        distributionN: overallDistribution.poolN,
        pValue: overallDistribution.pValue,
        fittedWeights: outcomeModel.fitted,
        included: individual.filter((item) => item.included),
        excluded: individual.filter((item) => !item.included),
        totalComponents: individual.length
      },
      fairness: { groups: groupTests, diagnostics },
      theorySupportedRounds: subjectRounds.filter((round) => round.theorySupported).length,
      limits: {
        poolIncludesHiddenDeadWall: true,
        opponentYakuAndFuritenNotChecked: true
      }
    };
  }

  function extractEmbeddedJson(html) {
    const document = new DOMParser().parseFromString(String(html || ""), "text/html");
    for (const script of [...document.querySelectorAll("script")]) {
      const text = script.textContent?.trim();
      if (!text || (!text.startsWith("{") && !text.startsWith("["))) continue;
      try {
        const parsed = JSON.parse(text);
        for (const candidate of [parsed, parsed?.props?.pageProps, parsed?.data, parsed?.result]) {
          try { return unwrapPayload(candidate); } catch { /* continue */ }
        }
      } catch { /* not JSON */ }
    }
    const match = String(html || "").match(/\/api\/v2\/tasks\/[^"'\\s<]+\/data\?token=[^"'\\s<]+/);
    return match ? { dataUrl: match[0].replace(/&amp;/g, "&") } : null;
  }

  return {
    VERSION,
    CALCULATION_VERSION,
    EXPERIENCE_MIN_POOL,
    DEFENSE_MIN_POOL,
    THEORY_MIN_N,
    RIICHI_MIN_N,
    analyzePayload,
    summarize,
    martingale,
    sigma: martingale,
    empiricalPercentile,
    bootstrapPercentile,
    cauchyCombine,
    recordMetricScores,
    roundMetricScores,
    fitOutcomeWeights,
    fitScoreRows,
    normalCdf,
    unwrapPayload,
    extractEmbeddedJson,
    splitMjaiRounds
  };
});
