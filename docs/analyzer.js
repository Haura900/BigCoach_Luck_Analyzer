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
  const EXPERIENCE_MIN_POOL = 30;
  const DEFENSE_MIN_POOL = 30;
  const THEORY_MIN_N = 20;
  const RIICHI_MIN_N = 10;
  const SEAT_NAMES = ["東家", "南家", "西家", "北家"];

  function clampProbability(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const normalized = numeric > 1 ? numeric / 100 : numeric;
    return Math.min(1, Math.max(0, normalized));
  }

  function mean(values) {
    const valid = (values || []).map(Number).filter(Number.isFinite);
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
      return { supported: false, dora: [], effective: [], genbutsu: [], riichiWin: [], riichiDealIn: [], seat: null };
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
    const seatIndex = ((hero - Number(start.oya || 0)) % playerCount + playerCount) % playerCount;
    const seat = SEAT_NAMES[seatIndex] || `席${seatIndex + 1}`;
    const baseMeta = { gameId: context.gameId, roundKey: context.roundKey, seat };
    const result = { supported: true, dora: [], effective: [], genbutsu: [], riichiWin: [], riichiDealIn: [], seat };

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

    for (const event of events.slice(1)) {
      const actor = Number(event?.actor);
      if (event?.type === "tsumo" && actor >= 0 && actor < playerCount) {
        const state = poolState();
        const actualId = core.tile34(event.pai);
        if (state.total > 0 && actor === hero) {
          const doraIds = doraMarkers.map(core.doraFromMarker).filter((id) => id >= 0);
          let doraCopies = countIds(state.remaining, doraIds);
          const doraSet = new Set(doraIds);
          [4, 13, 22].forEach((id, suit) => {
            if (!doraSet.has(id)) doraCopies += Math.max(0, Number(redTotals[suit] || 0) - redOutside[suit]);
          });
          const drewDora = doraSet.has(actualId) || core.isRed(event.pai);
          result.dora.push(exposure(doraCopies / state.total, drewDora ? 1 : 0));

          const improving = core.improvingTiles(hands[hero], openMelds[hero]);
          result.effective.push(exposure(countIds(state.remaining, improving) / state.total, improving.includes(actualId) ? 1 : 0));

          const riichiOpponents = [...acceptedRiichi].filter((player) => player !== hero);
          if (riichiOpponents.length) {
            let common = new Set(discards[riichiOpponents[0]] || []);
            for (const player of riichiOpponents.slice(1)) {
              common = new Set([...common].filter((id) => discards[player].has(id)));
            }
            const ids = [...common];
            result.genbutsu.push(exposure(countIds(state.remaining, ids) / state.total, ids.includes(actualId) ? 1 : 0, { riichiOpponents: riichiOpponents.length }));
          }

          if (acceptedRiichi.has(hero)) {
            const ownWaits = core.winningTiles(hands[hero], openMelds[hero]);
            result.riichiWin.push(exposure(countIds(state.remaining, ownWaits) / state.total, ownWaits.includes(actualId) ? 1 : 0, { source: "ツモ" }));

            const opponentWaits = new Set();
            for (let player = 0; player < playerCount; player += 1) {
              if (player === hero || core.shanten(hands[player], openMelds[player]) !== 0) continue;
              for (const id of core.winningTiles(hands[player], openMelds[player])) opponentWaits.add(id);
            }
            for (const id of ownWaits) opponentWaits.delete(id);
            const ids = [...opponentWaits];
            result.riichiDealIn.push(exposure(countIds(state.remaining, ids) / state.total, ids.includes(actualId) ? 1 : 0, { opponentsTenpai: ids.length > 0 }));
          }
        } else if (state.total > 0 && actor !== hero && acceptedRiichi.has(hero) && acceptedRiichi.has(actor)) {
          const ownWaits = core.winningTiles(hands[hero], openMelds[hero]);
          pending[actor] = {
            p: countIds(state.remaining, ownWaits) / state.total,
            y: ownWaits.includes(actualId) ? 1 : 0,
            ownWaits
          };
        }
        addOutside(event.pai);
        hands[actor].push(event.pai);
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
        openMelds[actor] += 1;
        pending[actor] = null;
        continue;
      }

      if (event?.type === "ankan" && actor >= 0 && actor < playerCount) {
        for (const tile of event.consumed || []) core.removeTile(hands[actor], tile);
        openMelds[actor] += 1;
        pending[actor] = null;
        continue;
      }

      if (event?.type === "kakan" && actor >= 0 && actor < playerCount) {
        for (const tile of event.consumed || []) core.removeTile(hands[actor], tile);
        if (event.pai) core.removeTile(hands[actor], event.pai);
        pending[actor] = null;
        continue;
      }

      if (["hora", "ryukyoku", "end_kyoku"].includes(event?.type)) {
        for (let index = 0; index < pending.length; index += 1) pending[index] = null;
      }
    }
    return result;
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
      const dealP = firstEntry ? winProbability(firstEntry) : null;
      const placement = firstEntry ? placementProbabilities(firstEntry) : null;
      const info = firstEntry ? parseGameInfo(firstEntry) : {};
      const currentRank = Number(info?.rank);
      const expectedRank = placement ? placement.reduce((sum, p, rank) => sum + p * (rank + 1), 0) : null;
      const theory = analyzeMjaiRound(mjaiRounds[index], hero, redTotals, {
        gameId,
        roundKey: `${gameId}:${index}`
      });
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
        genbutsu: theory.genbutsu,
        riichiWin: theory.riichiWin,
        riichiDealIn: theory.riichiDealIn,
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
    return {
      schemaVersion: VERSION,
      id: `bc-${hashText(signature)}`,
      gameId,
      sourceUrl: meta.sourceUrl || "",
      title: meta.title || `BigCoach解析 ${kyokus.length}局`,
      importedAt: meta.importedAt || new Date().toISOString(),
      engine: String(data.engine || "BigCoach"),
      gameLength: String(data.game_length || ""),
      platform: String(meta.platform || ""),
      table: String(meta.table || data.split_logs?.[0]?.rule?.disp || ""),
      heroName,
      players,
      opponents: players.filter((name, index) => index !== hero && name),
      rounds
    };
  }

  function empiricalPercentile(value, pool) {
    const valid = (pool || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!Number.isFinite(Number(value)) || !valid.length) return null;
    const lower = valid.filter((item) => item < value).length;
    const equal = valid.filter((item) => item === value).length;
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
    const values = (subject || []).map(Number).filter(Number.isFinite);
    const reference = (pool || []).map(Number).filter(Number.isFinite);
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
    const variance = valid.reduce((sum, event) => sum + Number(event.p) * (1 - Number(event.p)), 0);
    const rawZ = variance > 0 ? (observed - expected) / Math.sqrt(variance) : null;
    const luckZ = rawZ == null ? null : rawZ * luckyDirection;
    return {
      n: valid.length,
      observed,
      expected,
      variance,
      rawZ,
      luckZ,
      percentile: luckZ == null ? null : normalCdf(luckZ) * 100,
      pValue: rawZ == null ? null : Math.min(1, 2 * (1 - normalCdf(Math.abs(rawZ))))
    };
  }

  function empiricalMetric(subjectValues, poolValues, minPool, seed) {
    const values = (subjectValues || []).map(Number).filter(Number.isFinite);
    const pool = (poolValues || []).map(Number).filter(Number.isFinite);
    const percentile = bootstrapPercentile(values, pool, seed);
    return {
      n: values.length,
      poolN: pool.length,
      value: mean(values),
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
    const genbutsu = martingale(groupRoundEvents(selected, "genbutsu"), 1);
    const riichiWin = martingale(groupRoundEvents(selected, "riichiWin"), 1);
    const riichiDealIn = martingale(groupRoundEvents(selected, "riichiDealIn"), -1);

    const individual = [
      { key: "deal", label: "配牌和了率", score: deal.percentile, included: deal.included, reason: `経験分布 ${deal.poolN}/${deal.minimum}局` },
      { key: "rankDeal", label: "配牌時平着変動", score: rankDeal.percentile, included: rankDeal.included, reason: `経験分布 ${rankDeal.poolN}/${rankDeal.minimum}局` },
      { key: "defense", label: "放銃予実幅", score: defense.percentile, included: defense.included, reason: `経験分布 ${defense.poolN}/${defense.minimum}局` },
      { key: "dora", label: "ドラツモ", score: dora.percentile, included: dora.n >= THEORY_MIN_N, reason: `対象 ${dora.n}/${THEORY_MIN_N}ツモ` },
      { key: "effective", label: "有効牌ツモ", score: effective.percentile, included: effective.n >= THEORY_MIN_N, reason: `対象 ${effective.n}/${THEORY_MIN_N}ツモ` },
      { key: "genbutsu", label: "被リーチ時現物", score: genbutsu.percentile, included: genbutsu.n >= RIICHI_MIN_N, reason: `対象 ${genbutsu.n}/${RIICHI_MIN_N}ツモ` },
      { key: "riichiWin", label: "リーチ時自明和了", score: riichiWin.percentile, included: riichiWin.n >= RIICHI_MIN_N, reason: `対象 ${riichiWin.n}/${RIICHI_MIN_N}機会` },
      { key: "riichiDealIn", label: "リーチ時危険牌", score: riichiDealIn.percentile, included: riichiDealIn.n >= RIICHI_MIN_N, reason: `対象 ${riichiDealIn.n}/${RIICHI_MIN_N}ツモ` }
    ];
    const component = Object.fromEntries(individual.map((item) => [item.key, item]));
    const families = [
      { key: "initial", label: "配牌", items: [component.deal, component.rankDeal] },
      { key: "defense", label: "守備", items: [component.defense, component.genbutsu] },
      { key: "draw", label: "通常ツモ", items: [component.dora, component.effective] },
      { key: "riichi", label: "リーチ後", items: [component.riichiWin, component.riichiDealIn] }
    ].map((family) => {
      const included = family.items.filter((item) => item.included && Number.isFinite(item.score));
      return { ...family, included: included.length > 0, score: mean(included.map((item) => item.score)) };
    });
    const includedFamilies = families.filter((family) => family.included);
    const overallScore = mean(includedFamilies.map((family) => family.score));

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
      { key: "genbutsuCalibration", label: "被リーチ時現物：理論値との一致", pValue: genbutsu.n >= RIICHI_MIN_N ? genbutsu.pValue : null, n: genbutsu.n, method: "逐次確率残差" },
      { key: "riichiWinCalibration", label: "リーチ和了牌：理論値との一致", pValue: riichiWin.n >= RIICHI_MIN_N ? riichiWin.pValue : null, n: riichiWin.n, method: "逐次確率残差" },
      { key: "riichiDangerCalibration", label: "リーチ危険牌：理論値との一致", pValue: riichiDealIn.n >= RIICHI_MIN_N ? riichiDealIn.pValue : null, n: riichiDealIn.n, method: "逐次確率残差" },
      { key: "seat", label: "有効牌残差 × 親からの席順", pValue: seatTest.pValue, n: seatTest.n, method: "半荘内置換検定" },
      { key: "serial", label: "有効牌残差の局間連続性", pValue: serialTest.pValue, n: serialTest.n, method: "半荘内順序置換" }
    ];
    const bigCoachDiagnostics = [
      { key: "dealFit", label: "配牌和了率：経験分布適合", pValue: deal.included ? deal.pValue : null, n: deal.n, method: "経験分布bootstrap" },
      { key: "rankFit", label: "配牌時平着変動：経験分布適合", pValue: rankDeal.included ? rankDeal.pValue : null, n: rankDeal.n, method: "経験分布bootstrap" },
      { key: "defenseFit", label: "放銃予実幅：経験分布適合", pValue: defense.included ? defense.pValue : null, n: defense.n, method: "経験分布bootstrap" },
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
      genbutsu,
      riichiWin,
      riichiDealIn,
      overall: {
        score: overallScore,
        families,
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
    normalCdf,
    unwrapPayload,
    extractEmbeddedJson,
    splitMjaiRounds
  };
});
