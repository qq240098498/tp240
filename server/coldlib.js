// 温控口径都集中在这里：监测段、时间线拼接、重叠取值、接缝豁免、超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

function roomOf(data, roomId) {
  return data.rooms.find((r) => r.id === roomId) || null;
}

function legsOfBatch(data, batchId) {
  return data.legs
    .filter((l) => l.batchId === batchId)
    .slice()
    .sort((a, b) => (a.seq < b.seq ? -1 : 1));
}

function isOutOfRange(value, settings) {
  return value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
}

// 一条记录落在哪些段的监测窗内：探头必须正是该段在册探头，时刻在闭区间 [startAt, endAt]；末段不封尾。
// 接缝那一秒若两探头都有点，靠时间线的同刻序号裁决由新段接管；只有旧探头有点则仍归旧段。
function legsCovering(legs, row) {
  return legs.filter((l) => l.probeId === row.probeId && l.startAt <= row.at && (l.endAt === null || l.endAt === '' || row.at <= l.endAt));
}

/* 时间线拼接：把一批货名下各段（设备+探头）的记录按时刻接成一条判定用时间线。

   重叠口径（页面与本函数必须一致）：
   1. 同一探头同一时刻既有自动又有手工更正：以手工为准，自动点落选并标注“手工更正”；
   2. 交接重叠时段（同一时刻两台探头都有记录）：以监测段序号靠后的段为准，
      即交接后新探头/新设备接管，旧探头点落选并标注“交接重叠未采用”；
   3. 停用探头名下的记录、不落在任何监测段窗内的记录一律不参与判定。 */
function timeline(data, batchId) {
  const legs = legsOfBatch(data, batchId);
  const raw = recordsOfBatch(data, batchId).map((row, index) => Object.assign({ _index: index }, row));
  const groups = {};
  const order = [];
  const dropped = [];

  function pushDrop(row, reason, leg) {
    dropped.push({
      id: row.id, at: row.at, probeId: row.probeId, temperatureC: row.temperatureC,
      source: row.source, operator: row.operator, legId: leg ? leg.id : '', reason,
    });
  }

  for (const row of raw) {
    if (!Number.isFinite(Number(row.temperatureC))) {
      pushDrop(row, '温度不是有效数值，不参与判定（请补录或更正这条记录）');
      continue;
    }
    const probe = probeOf(data, row.probeId);
    if (probe && probe.status === '停用') {
      pushDrop(row, '停用探头名下的记录不参与判定');
      continue;
    }
    const covers = legsCovering(legs, row);
    if (!covers.length) {
      const anyWindow = legs.some((l) => l.startAt <= row.at && (l.endAt === null || l.endAt === '' || row.at <= l.endAt));
      pushDrop(row, anyWindow ? '该时刻在册的监测探头不是这台探头，记录不归任何监测段' : '记录时刻不在任何监测段的起止时间窗内');
      continue;
    }
    const key = row.at;
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push({ row, legs: covers });
  }

  const points = [];
  for (const at of order) {
    // 同一刻：段序号靠后的段接管；同段内（同一探头）手工更正压过自动。
    const ranked = groups[at].slice().sort((a, b) => {
      const sa = Math.max.apply(null, a.legs.map((l) => l.seq));
      const sb = Math.max.apply(null, b.legs.map((l) => l.seq));
      if (sb !== sa) return sb - sa;
      const ma = a.row.source === '人工' ? 1 : 0;
      const mb = b.row.source === '人工' ? 1 : 0;
      if (mb !== ma) return mb - ma;
      return a.row._index - b.row._index;
    });
    const winner = ranked[0];
    const winLeg = winner.legs.slice().sort((a, b) => b.seq - a.seq)[0];
    const winProbe = probeOf(data, winner.row.probeId);
    points.push({
      id: winner.row.id,
      at: winner.row.at,
      probeId: winner.row.probeId,
      temperatureC: Number(winner.row.temperatureC),
      source: winner.row.source,
      operator: winner.row.operator || '',
      legId: winLeg.id,
      seq: winLeg.seq,
      roomId: winLeg.roomId,
      probeStatus: winProbe ? winProbe.status : '',
    });
    for (const loser of ranked.slice(1)) {
      const sameProbe = loser.row.probeId === winner.row.probeId;
      pushDrop(
        loser.row,
        sameProbe ? '同一时刻已有手工更正记录，自动点不采用' : '交接重叠时段，以序号靠后的监测段（新探头/新设备）为准',
        loser.legs[0]
      );
    }
  }

  points.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a._index - b._index));
  dropped.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { legs, points, dropped };
}

// 参与判定的有效记录（对外保留旧接口名）
function effectiveRecords(data, batchId) {
  return timeline(data, batchId).points;
}

/* 超限：同一段内连续超出上下限的时段，回到范围内即断开；
   段时长按相邻记录的实际时刻差累加；换段（换设备/换探头）后重新起一段。 */
function segmentsForLeg(points, settings) {
  const segments = [];
  let current = null;
  let previous = null;
  for (const point of points) {
    const out = isOutOfRange(point.temperatureC, settings);
    if (out) {
      const gapMinutes = previous ? store.minutesBetween(previous.at, point.at) : 0;
      if (current) {
        current.endAt = point.at;
        current.minutes += gapMinutes;
        current.peakC = point.temperatureC > current.peakC ? point.temperatureC : current.peakC;
        current.recordIds.push(point.id);
        current.points += 1;
      } else {
        current = {
          startAt: point.at, endAt: point.at, minutes: 0, peakC: point.temperatureC,
          points: 1, recordIds: [point.id],
        };
        segments.push(current);
      }
    } else {
      current = null;
    }
    previous = point;
  }
  return segments;
}

function excursionStats(data, batchId) {
  const tl = timeline(data, batchId);
  const segmentsByLeg = tl.legs.map((leg) => {
    const rows = tl.points.filter((p) => p.legId === leg.id);
    const segs = segmentsForLeg(rows, data.settings).map((s) => Object.assign({ legId: leg.id, seq: leg.seq }, s));
    return { legId: leg.id, seq: leg.seq, roomId: leg.roomId, probeId: leg.probeId, segments: segs };
  });
  const all = segmentsByLeg.reduce((acc, l) => acc.concat(l.segments), []);
  const longest = all.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0, recordIds: [], legId: '', seq: 0 });
  const total = store.round(all.reduce((acc, s) => acc + s.minutes, 0));
  return {
    segments: all,
    segmentsByLeg,
    longestMinutes: longest.minutes,
    longest,
    totalMinutes: total,
    segmentCount: all.length,
    recordCount: tl.points.length,
    firstAt: tl.points.length ? tl.points[0].at : '',
    lastAt: tl.points.length ? tl.points[tl.points.length - 1].at : '',
  };
}

/* 缺口：
   - 段内相邻记录时刻差超过 chainGapMinutes → 真断链（in-leg），不可豁免；
   - 段与段的接缝（上一段末点 → 下一段首点）超过 chainGapMinutes：
       不超过 handoverGraceMinutes → 换探头/换设备造成的交接空档，按口径豁免并标注原因；
       超过宽限 → 仍按真断链计，豁免盖不住。 */
function chainGaps(data, batchId) {
  const settings = data.settings;
  const threshold = Number(settings.chainGapMinutes);
  const grace = Number(settings.handoverGraceMinutes);
  const tl = timeline(data, batchId);
  const gaps = [];
  const emptyLegs = [];

  tl.legs.forEach((leg) => {
    const rows = tl.points.filter((p) => p.legId === leg.id);
    if (!rows.length) {
      emptyLegs.push({ legId: leg.id, seq: leg.seq, roomId: leg.roomId, probeId: leg.probeId, reason: '这一段没有任何温度记录，属于真漏数据' });
      return;
    }
    for (let i = 1; i < rows.length; i += 1) {
      const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
      if (minutes > threshold) {
        gaps.push({
          kind: 'in-leg', exempt: false, legId: leg.id, seq: leg.seq, roomId: leg.roomId, probeId: leg.probeId,
          from: rows[i - 1].at, to: rows[i].at, minutes,
          reason: '同一段监测内相邻记录相差 ' + minutes + ' 分钟，超过断链门槛 ' + threshold + ' 分钟',
        });
      }
    }
  });

  for (let i = 1; i < tl.legs.length; i += 1) {
    const prev = tl.legs[i - 1];
    const next = tl.legs[i];
    // 接缝锚点：旧探头在新段开始之前的最后一条、新探头的第一条（并行重叠尾巴不算空档）
    const a = tl.points.filter((p) => p.legId === prev.id && p.at < next.startAt).pop();
    const b = tl.points.filter((p) => p.legId === next.id)[0];
    if (!a || !b) continue; // 空段已在 emptyLegs 里点名
    const minutes = store.minutesBetween(a.at, b.at);
    if (minutes > threshold) {
      const exempt = minutes <= grace;
      gaps.push({
        kind: 'seam', exempt, legId: next.id, seq: next.seq, roomId: next.roomId, probeId: next.probeId,
        fromLegId: prev.id, fromSeq: prev.seq, from: a.at, to: b.at, minutes,
        reason: exempt
          ? '第 ' + prev.seq + ' 段换第 ' + next.seq + ' 段的交接空档 ' + minutes + ' 分钟，未超过交接宽限 ' + grace + ' 分钟，按口径豁免（原因：换探头/换设备）'
          : '第 ' + prev.seq + ' 段换第 ' + next.seq + ' 段的交接空档长达 ' + minutes + ' 分钟，超过交接宽限 ' + grace + ' 分钟，按真断链计，豁免盖不住',
      });
    }
  }

  gaps.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
  const real = gaps.filter((g) => !g.exempt);
  return {
    gaps,
    gapCount: real.length,
    totalGapMinutes: real.reduce((acc, g) => acc + g.minutes, 0),
    exemptGaps: gaps.filter((g) => g.exempt),
    exemptGapCount: gaps.filter((g) => g.exempt).length,
    emptyLegs,
  };
}

// MKT：MKT = −Ea / (R × ln((Σ e^(−Ea/(R·T))) / n)) − 273.15，不是取算术平均
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const ea = Number(settings.mktActivationEnergy);
  const r = Number(settings.gasConstant);
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Math.exp((-ea / r) / (row.temperatureC + 273.15)), 0);
  const mktKelvin = (-ea / r) / Math.log(sum / rows.length);
  return store.round(mktKelvin - 273.15, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

// 按段点名：哪一段、哪个探头、哪几条记录时探头已过校准期
function expiredByLeg(data, batchId) {
  const tl = timeline(data, batchId);
  const bad = [];
  tl.legs.forEach((leg) => {
    const probe = probeOf(data, leg.probeId);
    const hits = tl.points.filter((p) => p.legId === leg.id && !probeValidOn(probe, String(p.at).slice(0, 10)));
    if (hits.length) {
      bad.push({
        legId: leg.id, seq: leg.seq, roomId: leg.roomId, probeId: leg.probeId,
        probeCode: probe ? probe.code : '', calibratedUntil: probe ? probe.calibratedUntil : '',
        at: hits[0].at, recordIds: hits.map((p) => p.id),
      });
    }
  });
  return bad;
}

function expiredProbes(data, batchId) {
  return expiredByLeg(data, batchId).map((b) => ({
    probeId: b.probeId, probeCode: b.probeCode, calibratedUntil: b.calibratedUntil, at: b.at,
  }));
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function decorateLeg(data, leg, tl) {
  const room = roomOf(data, leg.roomId);
  const probe = probeOf(data, leg.probeId);
  const rows = tl.points.filter((p) => p.legId === leg.id);
  return {
    id: leg.id,
    seq: leg.seq,
    roomId: leg.roomId,
    roomCode: room ? room.code : '',
    roomName: room ? room.name : '',
    roomType: room ? room.type : '',
    roomStatus: room ? room.status : '',
    probeId: leg.probeId,
    probeCode: probe ? probe.code : '',
    probeStatus: probe ? probe.status : '',
    calibratedUntil: probe ? probe.calibratedUntil : '',
    startAt: leg.startAt,
    endAt: leg.endAt,
    handoffReason: leg.handoffReason || '',
    remark: leg.remark || '',
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  };
}

// 放行判定：最长超限、累计超限、断链（豁免单列）、探头校准四条 + 无记录闸口；
// 任一条不过整批不合格，并按段指出肇事记录与责任设备。
function releaseCheck(data, batch) {
  const settings = data.settings;
  const tl = timeline(data, batch.id);
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const expired = expiredByLeg(data, batch.id);

  const legSummary = tl.legs.map((leg) => {
    const base = decorateLeg(data, leg, tl);
    const segInfo = stats.segmentsByLeg.find((s) => s.legId === leg.id) || { segments: [] };
    const legGaps = chain.gaps.filter((g) => g.legId === leg.id);
    return Object.assign(base, {
      longestMinutes: segInfo.segments.reduce((acc, s) => (s.minutes > acc ? s.minutes : acc), 0),
      totalMinutes: store.round(segInfo.segments.reduce((acc, s) => acc + s.minutes, 0)),
      segments: segInfo.segments,
      gaps: legGaps,
      realGapCount: legGaps.filter((g) => !g.exempt).length,
      exemptGapCount: legGaps.filter((g) => g.exempt).length,
    });
  });

  const code = (l) => (l.roomCode ? l.roomCode + ' ' + l.roomName : '未登记设备');
  const longSegs = stats.segments.filter((s) => s.minutes > Number(settings.allowExcursionMinutes));
  const totalCulprits = stats.segments.filter((s) => s.minutes > 0);

  const conditions = [
    {
      key: 'longest',
      ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes),
      value: stats.longestMinutes,
      limit: Number(settings.allowExcursionMinutes),
      text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟',
      culprits: longSegs.map((s) => {
        const leg = legSummary.find((l) => l.id === s.legId);
        return { seq: s.seq, device: leg ? code(leg) : '', probeCode: leg ? leg.probeCode : '', from: s.startAt, to: s.endAt, minutes: s.minutes, recordIds: s.recordIds };
      }),
    },
    {
      key: 'total',
      ok: stats.totalMinutes <= Number(settings.allowTotalExcursionMinutes),
      value: stats.totalMinutes,
      limit: Number(settings.allowTotalExcursionMinutes),
      text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟（跨月不重置，按批次周期累计）',
      culprits: totalCulprits.map((s) => {
        const leg = legSummary.find((l) => l.id === s.legId);
        return { seq: s.seq, device: leg ? code(leg) : '', probeCode: leg ? leg.probeCode : '', from: s.startAt, to: s.endAt, minutes: s.minutes, recordIds: s.recordIds };
      }),
    },
    {
      key: 'chain',
      ok: chain.gapCount === 0 && chain.emptyLegs.length === 0,
      value: chain.gapCount + chain.emptyLegs.length,
      limit: 0,
      text: '全程没有真断链（换探头/换设备的交接空档在宽限 ' + settings.handoverGraceMinutes + ' 分钟内可豁免，超宽限与段内缺口仍算断链）',
      culprits: chain.gaps.filter((g) => !g.exempt).map((g) => {
        const leg = legSummary.find((l) => l.id === g.legId);
        return { seq: g.seq, device: leg ? code(leg) : '', probeCode: leg ? leg.probeCode : '', from: g.from, to: g.to, minutes: g.minutes, reason: g.reason };
      }).concat(chain.emptyLegs.map((e) => {
        const leg = legSummary.find((l) => l.id === e.legId);
        return { seq: e.seq, device: leg ? code(leg) : '', probeCode: leg ? leg.probeCode : '', reason: e.reason };
      })),
      exemptions: chain.exemptGaps.map((g) => {
        const leg = legSummary.find((l) => l.id === g.legId);
        return { seq: g.seq, device: leg ? code(leg) : '', probeCode: leg ? leg.probeCode : '', from: g.from, to: g.to, minutes: g.minutes, reason: g.reason };
      }),
    },
    {
      key: 'calibration',
      ok: expired.length === 0,
      value: expired.length,
      limit: 0,
      text: '参与判定的探头都在校准有效期内',
      culprits: expired.map((e) => {
        const leg = legSummary.find((l) => l.id === e.legId);
        return { seq: e.seq, device: leg ? code(leg) : '', probeCode: e.probeCode, calibratedUntil: e.calibratedUntil, at: e.at, recordIds: e.recordIds };
      }),
    },
    {
      key: 'records',
      ok: tl.points.length > 0,
      value: tl.points.length,
      limit: 1,
      text: '至少有一条参与判定的温度记录（没有记录的批次不能放行）',
      culprits: [],
    },
  ];

  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    droppedCount: tl.dropped.length,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    legs: legSummary,
    chain: { gaps: chain.gaps, gapCount: chain.gapCount, exemptGapCount: chain.exemptGapCount, emptyLegs: chain.emptyLegs },
    expiredProbes: expired.map((e) => ({ probeId: e.probeId, probeCode: e.probeCode, calibratedUntil: e.calibratedUntil, at: e.at })),
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

module.exports = {
  toDate,
  probeOf,
  roomOf,
  legsOfBatch,
  timeline,
  recordsOfBatch,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredByLeg,
  expiredProbes,
  accumulatedExcursionMinutes,
  releaseCheck,
};
