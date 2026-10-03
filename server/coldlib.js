// 温控口径都集中在这里：监护段拼接、超限段、断链与接缝、MKT、放行判定
const store = require('./store');

// 拼接口径的说明文字：页面直接展示，README「口径」一节与这里保持一致
const RULES_TEXT = {
  stitch: '一批货可登记多段监护段，每段绑定一台探头与一个设备（冷库或冷藏车）；判定时按时刻把各段记录接成一条时间线。没登记监护段的批次按旧口径把名下记录合并判定，并在页面上标出来。',
  overlap: '同一时刻有多条记录时只取一条：手工记录优先于自动记录；来源相同时，后开始的段（新接管的探头）优先；再相同则后登记的记录优先。没被采用的记录逐条列在「被压盖记录」里，可回看。',
  seam: '段与段的接缝处，相邻两条记录的空档不超过交接宽限（设置里的 handoverGraceMinutes，默认 60 分钟）的，认定为换探头/换设备造成的交接空档，豁免断链并逐条标注原因；超过交接宽限的接缝空档、以及同一段内超过断链门槛的空档，一律算断链，不允许用豁免盖掉真断链。',
  segment: '任一段触及超限、断链或探头校准过期，整批即不满足放行条件；判定结果点名到段、到记录、到设备。',
};

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id < b.id ? -1 : 1)));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

function roomOf(data, roomId) {
  return data.rooms.find((r) => r.id === roomId) || null;
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

// 监护段：一批货从入库到放行由若干段拼接，每段一台探头、一个设备，按开始时刻排序并编号
function segmentsOfBatch(data, batchId) {
  return (data.segments || [])
    .filter((s) => s.batchId === batchId)
    .slice()
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : (a.id < b.id ? -1 : 1)))
    .map((s, i) => Object.assign({}, s, { seq: i + 1 }));
}

// 段结束时刻留空表示进行中
function segEnd(seg) {
  return seg.to && String(seg.to).trim() ? String(seg.to) : '9999-12-31 23:59:59';
}

// 同一时刻多条候选只取一条：手工 > 自动；再按后开始的段；再按后登记的段；再按后登记的记录
function compareCandidate(a, b) {
  const ma = a.rec.source === '人工' ? 1 : 0;
  const mb = b.rec.source === '人工' ? 1 : 0;
  if (ma !== mb) return mb - ma;
  const fa = a.seg ? a.seg.from : '';
  const fb = b.seg ? b.seg.from : '';
  if (fa !== fb) return fa < fb ? 1 : -1;
  const sa = a.seg ? a.seg.id : '';
  const sb = b.seg ? b.seg.id : '';
  if (sa !== sb) return sa < sb ? 1 : -1;
  return a.rec.id < b.rec.id ? 1 : -1;
}

function winnerReason(cand) {
  if (cand.rec.source === '人工') return '手工记录优先';
  if (cand.seg) return '后开始的段（新接管探头）优先';
  return '后登记的记录优先';
}

// 去重：分段模式下同一时刻（跨探头）只取一条；未分段模式保持旧口径，同一探头同一时刻只取一条
function dedupRows(candidates, segmented) {
  const groups = new Map();
  for (const cand of candidates) {
    const key = segmented ? cand.rec.at : cand.rec.probeId + '|' + cand.rec.at;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cand);
  }
  const picked = [];
  const suppressed = [];
  for (const group of groups.values()) {
    group.sort(compareCandidate);
    const winner = group[0];
    picked.push(winner);
    for (let i = 1; i < group.length; i += 1) {
      suppressed.push(Object.assign({}, group[i].rec, {
        segmentId: group[i].seg ? group[i].seg.id : '',
        segmentSeq: group[i].seg ? group[i].seg.seq : 0,
        suppressedBy: winner.rec.id,
        reason: '同一时刻采用记录 ' + winner.rec.id + '（' + winnerReason(winner) + '），本条未参与判定',
      }));
    }
  }
  picked.sort((a, b) => (a.rec.at < b.rec.at ? -1 : a.rec.at > b.rec.at ? 1 : 0));
  return { picked, suppressed };
}

// 把一批货的各段记录接成一条时间线
function buildTimeline(data, batch) {
  const settings = data.settings;
  const chainGap = Number(settings.chainGapMinutes);
  const handoverGrace = Number(settings.handoverGraceMinutes);
  const all = recordsOfBatch(data, batch.id);

  // 停用探头名下的记录不参与判定（口径 7），逐条列出备查
  const usable = [];
  const disabledDropped = [];
  for (const rec of all) {
    const probe = probeOf(data, rec.probeId);
    if (probe && probe.status === '停用') disabledDropped.push(rec);
    else usable.push(rec);
  }

  const segments = segmentsOfBatch(data, batch.id);

  if (!segments.length) {
    const dedup = dedupRows(usable.map((rec) => ({ rec, seg: null })), false);
    const rows = dedup.picked.map((c) => Object.assign({}, c.rec, { segmentId: '', segmentSeq: 0 }));
    const gaps = [];
    for (let i = 1; i < rows.length; i += 1) {
      const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
      if (minutes > chainGap) {
        gaps.push({
          kind: 'gap', from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: minutes,
          fromSegmentId: '', toSegmentId: '', fromSeq: 0, toSeq: 0,
          reason: '相邻记录间隔 ' + minutes + ' 分钟，超过断链门槛 ' + chainGap + ' 分钟',
        });
      }
    }
    return { unsegmented: true, rows, segments: [], seams: [], gaps, suppressed: dedup.suppressed, orphans: [], disabledDropped };
  }

  // 1) 记录归段：探头匹配且时刻落在段窗口内；多段同抢一条时后开始的段优先
  const byProbe = {};
  for (const seg of segments) {
    if (!byProbe[seg.probeId]) byProbe[seg.probeId] = [];
    byProbe[seg.probeId].push(seg);
  }
  const orphans = [];
  const candidates = [];
  for (const rec of usable) {
    const segs = (byProbe[rec.probeId] || []).filter((s) => s.from <= rec.at && rec.at <= segEnd(s));
    if (!segs.length) {
      orphans.push(rec);
      continue;
    }
    segs.sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : (a.id < b.id ? 1 : -1)));
    candidates.push({ rec, seg: segs[0] });
  }

  // 2) 同一时刻多条取一条（口径见 RULES_TEXT.overlap），其余进被压盖清单
  const dedup = dedupRows(candidates, true);
  const rows = dedup.picked.map((c) => Object.assign({}, c.rec, { segmentId: c.seg.id, segmentSeq: c.seg.seq }));

  // 3) 接缝与断链：段间空档在交接宽限内豁免并标注，超宽限或段内空档照旧算断链
  const segById = {};
  for (const s of segments) segById[s.id] = s;
  const seams = [];
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const minutes = store.minutesBetween(prev.at, cur.at);
    if (minutes <= chainGap) continue;
    if (prev.segmentId !== cur.segmentId) {
      const fromSeg = segById[prev.segmentId];
      const toSeg = segById[cur.segmentId];
      const label = '段' + fromSeg.seq + '→段' + toSeg.seq;
      if (minutes <= handoverGrace) {
        seams.push({
          kind: 'handover', from: prev.at, to: cur.at, minutes,
          fromSegmentId: fromSeg.id, toSegmentId: toSeg.id, fromSeq: fromSeg.seq, toSeq: toSeg.seq,
          reason: label + ' 交接空档 ' + minutes + ' 分钟，未超过交接宽限 ' + handoverGrace + ' 分钟，按口径豁免（换探头/换设备' + (toSeg.reason ? '；段' + toSeg.seq + ' 事由：' + toSeg.reason : '') + '）',
        });
      } else {
        gaps.push({
          kind: 'seam', from: prev.at, to: cur.at, minutes, countedMinutes: minutes,
          fromSegmentId: fromSeg.id, toSegmentId: toSeg.id, fromSeq: fromSeg.seq, toSeq: toSeg.seq,
          reason: label + ' 接缝空档 ' + minutes + ' 分钟，超过交接宽限 ' + handoverGrace + ' 分钟，按断链计',
        });
      }
    } else {
      const seg = segById[cur.segmentId];
      gaps.push({
        kind: 'gap', from: prev.at, to: cur.at, minutes, countedMinutes: minutes,
        fromSegmentId: seg.id, toSegmentId: seg.id, fromSeq: seg.seq, toSeq: seg.seq,
        reason: '段' + seg.seq + ' 内相邻记录间隔 ' + minutes + ' 分钟，超过断链门槛 ' + chainGap + ' 分钟',
      });
    }
  }

  return { unsegmented: false, rows, segments, seams, gaps, suppressed: dedup.suppressed, orphans, disabledDropped };
}

// 超限段：连续超出上下限的时段，回到范围内即断开；时长按段内相邻记录的实际时刻差累加
function excursionStats(rows, settings) {
  const lower = Number(settings.lowerLimitC);
  const upper = Number(settings.upperLimitC);
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > upper || value < lower;
    if (out) {
      if (!current) {
        current = { id: 'ex-' + (segments.length + 1), startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: [] };
        segments.push(current);
      }
      current.endAt = row.at;
      if (value > current.peakC) current.peakC = value;
      current.points.push(row);
    } else {
      current = null;
    }
  }
  for (const seg of segments) {
    let minutes = 0;
    for (let i = 1; i < seg.points.length; i += 1) minutes += store.minutesBetween(seg.points[i - 1].at, seg.points[i].at);
    seg.minutes = minutes;
    seg.pointCount = seg.points.length;
    seg.segmentIds = [];
    for (const p of seg.points) {
      if (p.segmentId && seg.segmentIds.indexOf(p.segmentId) === -1) seg.segmentIds.push(p.segmentId);
    }
  }
  const longestMinutes = segments.reduce((acc, s) => (s.minutes > acc ? s.minutes : acc), 0);
  const totalMinutes = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes, totalMinutes, count: segments.length };
}

// MKT：平均动力学温度，按动力学公式，不是算术平均
function mktCelsius(settings, rows) {
  if (!rows.length) return 0;
  const Ea = Number(settings.mktActivationEnergy);
  const R = Number(settings.gasConstant);
  const sum = rows.reduce((acc, row) => acc + Math.exp(-Ea / (R * (Number(row.temperatureC) + 273.15))), 0);
  return store.round(-Ea / (R * Math.log(sum / rows.length)) - 273.15, 2);
}

// 参与判定的探头里，校准有效期盖不住记录时刻的，逐段列出
function expiredEntries(data, rows) {
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      const key = (row.segmentId || 'legacy') + '|' + probe.id;
      if (!bad.some((b) => b.key === key)) {
        bad.push({
          key,
          segmentId: row.segmentId || '',
          segmentSeq: row.segmentSeq || 0,
          probeId: probe.id,
          probeCode: probe.code,
          calibratedUntil: probe.calibratedUntil,
          at: row.at,
        });
      }
    }
  }
  return bad;
}

// 段内分到的超限时长：每个相邻点间隔记到后一个点所在的段
function attributedExcursionMinutes(excursions, segmentId) {
  let minutes = 0;
  for (const seg of excursions) {
    for (let i = 1; i < seg.points.length; i += 1) {
      if (seg.points[i].segmentId === segmentId) minutes += store.minutesBetween(seg.points[i - 1].at, seg.points[i].at);
    }
  }
  return minutes;
}

// 在拼接好的时间线上做放行判定，并逐段归因
function judgeTimeline(data, batch, tl) {
  const settings = data.settings;
  const ex = excursionStats(tl.rows, settings);
  const expired = expiredEntries(data, tl.rows);
  const realGapMinutes = tl.gaps.reduce((acc, g) => acc + g.countedMinutes, 0);

  const conditions = [
    { key: 'records', ok: tl.rows.length > 0, value: tl.rows.length, limit: 1, text: '有参与判定的温度记录' },
    { key: 'longest', ok: ex.longestMinutes <= Number(settings.allowExcursionMinutes), value: ex.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: ex.totalMinutes <= Number(settings.allowTotalExcursionMinutes), value: ex.totalMinutes, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟（按批次周期累计，跨月不重置）' },
    { key: 'chain', ok: tl.gaps.length === 0, value: tl.gaps.length, limit: 0, text: '全程没有断链（按口径豁免的交接空档不算）' },
    { key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' },
  ];
  const failedKeys = conditions.filter((c) => !c.ok).map((c) => c.key);
  const longestList = ex.segments.filter((s) => s.minutes === ex.longestMinutes && ex.longestMinutes > 0);

  // 逐段结论：哪一段被哪条未满足的条件点名，点名到记录与设备
  const segVerdicts = tl.segments.map((seg) => {
    const rows = tl.rows.filter((r) => r.segmentId === seg.id);
    const touched = ex.segments.filter((s) => s.segmentIds.indexOf(seg.id) !== -1);
    const segGaps = tl.gaps.filter((g) => g.fromSegmentId === seg.id || g.toSegmentId === seg.id);
    const segSeams = tl.seams.filter((s) => s.fromSegmentId === seg.id || s.toSegmentId === seg.id);
    const segExpired = expired.filter((e) => e.segmentId === seg.id);
    const problems = [];
    if (failedKeys.indexOf('longest') !== -1) {
      for (const s of longestList) {
        if (s.segmentIds.indexOf(seg.id) !== -1) problems.push('最长超限段 ' + s.id + '（' + s.minutes + ' 分钟）触及本段');
      }
    }
    if (failedKeys.indexOf('total') !== -1) {
      for (const s of touched) problems.push('累计超限含本段超限段 ' + s.id + '（' + s.minutes + ' 分钟）');
    }
    if (failedKeys.indexOf('chain') !== -1) {
      for (const g of segGaps) problems.push('断链：' + g.reason);
    }
    if (failedKeys.indexOf('calibration') !== -1 && segExpired.length) {
      problems.push('探头校准有效期盖不住本段记录');
    }
    return {
      id: seg.id,
      seq: seg.seq,
      batchId: seg.batchId,
      probeId: seg.probeId,
      roomId: seg.roomId,
      from: seg.from,
      to: seg.to,
      reason: seg.reason,
      recordCount: rows.length,
      firstAt: rows.length ? rows[0].at : '',
      lastAt: rows.length ? rows[rows.length - 1].at : '',
      excursionMinutes: attributedExcursionMinutes(ex.segments, seg.id),
      excursionIds: touched.map((s) => s.id),
      gapCount: segGaps.length,
      exemptSeamCount: segSeams.length,
      expired: segExpired.length > 0,
      ok: problems.length === 0,
      problems,
    };
  });

  return {
    pass: conditions.every((c) => c.ok),
    failed: failedKeys,
    conditions,
    mkt: mktCelsius(settings, tl.rows),
    longestMinutes: ex.longestMinutes,
    totalMinutes: ex.totalMinutes,
    recordCount: tl.rows.length,
    firstAt: tl.rows.length ? tl.rows[0].at : '',
    lastAt: tl.rows.length ? tl.rows[tl.rows.length - 1].at : '',
    chain: {
      gaps: tl.gaps,
      gapCount: tl.gaps.length,
      totalGapMinutes: realGapMinutes,
      exemptSeams: tl.seams,
      exemptCount: tl.seams.length,
    },
    excursions: ex.segments,
    excursionCount: ex.count,
    expiredProbes: expired,
    segments: segVerdicts,
    unsegmented: tl.unsegmented,
    orphanCount: tl.orphans.length,
    suppressedCount: tl.suppressed.length,
    disabledRecordCount: tl.disabledDropped.length,
    rules: RULES_TEXT,
  };
}

function releaseCheck(data, batch) {
  return judgeTimeline(data, batch, buildTimeline(data, batch));
}

module.exports = {
  toDate,
  probeOf,
  roomOf,
  probeValidOn,
  recordsOfBatch,
  segmentsOfBatch,
  segEnd,
  buildTimeline,
  excursionStats,
  mktCelsius,
  expiredEntries,
  judgeTimeline,
  releaseCheck,
  RULES_TEXT,
};
