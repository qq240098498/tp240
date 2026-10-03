const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    recordCount: stats.recordCount,
    droppedCount: check.droppedCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    exemptGapCount: check.chain.exemptGapCount,
    legCount: check.legs.length,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
}

function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateRoom(data, room);
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return decorateProbe(data, probe);
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const tl = coldlib.timeline(data, id);
  const probeText = (probeId) => {
    const probe = coldlib.probeOf(data, probeId);
    return probe ? probe.code : '';
  };
  const timelineRows = tl.points.map((p) => {
    const probe = coldlib.probeOf(data, p.probeId);
    return {
      id: p.id, at: p.at, probeId: p.probeId, probeCode: probeText(p.probeId),
      temperatureC: p.temperatureC, source: p.source, operator: p.operator,
      legId: p.legId, seq: p.seq,
      roomCode: (data.rooms.find((r) => r.id === p.roomId) || {}).code || '',
      outOfRange: p.temperatureC > Number(data.settings.upperLimitC) || p.temperatureC < Number(data.settings.lowerLimitC),
      probeExpired: !coldlib.probeValidOn(probe, String(p.at).slice(0, 10)),
      probeStatus: probe ? probe.status : '',
    };
  });
  const droppedRows = tl.dropped.map((d) => Object.assign({}, d, { probeCode: probeText(d.probeId) }));
  const stats = coldlib.excursionStats(data, id);
  return Object.assign({}, decorateBatch(data, batch), {
    legs: coldlib.releaseCheck(data, batch).legs,
    timeline: timelineRows,
    droppedRecords: droppedRows,
    records: timelineRows,
    effectiveRecords: timelineRows,
    segments: stats.segments,
    segmentsByLeg: stats.segmentsByLeg,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    chainDetail: coldlib.chainGaps(data, id),
    releases: data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)),
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: merged.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.legs = data.legs.filter((l) => l.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

/* ---------- 监测段（一批货可以跨多台探头、多个设备） ---------- */

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function listLegs(data, query) {
  const q = query || {};
  let rows = data.legs.slice();
  if (q.batchId) rows = rows.filter((l) => l.batchId === q.batchId);
  const tlCache = {};
  return rows
    .map((l) => {
      if (!tlCache[l.batchId]) tlCache[l.batchId] = coldlib.timeline(data, l.batchId);
      return decorateLegPub(data, l, tlCache[l.batchId]);
    })
    .sort((a, b) => (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : a.seq - b.seq));
}

function decorateLegPub(data, leg, tl) {
  const room = data.rooms.find((r) => r.id === leg.roomId);
  const probe = data.probes.find((p) => p.id === leg.probeId);
  const rows = tl.points.filter((p) => p.legId === leg.id);
  return {
    id: leg.id,
    batchId: leg.batchId,
    seq: leg.seq,
    roomId: leg.roomId,
    roomCode: room ? room.code : '',
    roomName: room ? room.name : '',
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

function legPayloadErrors(data, batch, payload, legs, selfId) {
  const errors = {};
  if (!data.rooms.some((r) => r.id === payload.roomId)) errors.roomId = '监测设备（冷库/冷藏车）不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!payload.probeId) errors.probeId = '要挂一台探头';
  else if (!probe) errors.probeId = '探头不存在';
  else if (probe.roomId !== payload.roomId) errors.probeId = '这台探头不属于所选设备，请在该设备名下选探头';
  else if (probe.status === '停用') errors.probeId = '停用探头不能挂到监测段上（其记录不参与判定）';
  if (!TIME_RE.test(String(payload.startAt || ''))) errors.startAt = '开始时刻格式要像 2026-09-01 08:00:00';
  if (payload.endAt !== null && payload.endAt !== '' && !TIME_RE.test(String(payload.endAt || ''))) {
    errors.endAt = '结束时刻留空表示当前段，或填 2026-09-01 08:00:00';
  }
  if (!errors.startAt && payload.startAt < batch.loadedAt) errors.startAt = '监测段不能早于批次入库时刻 ' + batch.loadedAt;
  if (!errors.startAt && !errors.endAt && payload.endAt && payload.endAt <= payload.startAt) {
    errors.endAt = '结束时刻要晚于开始时刻';
  }
  return { errors, probe };
}

function createLeg(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const legs = data.legs.filter((l) => l.batchId === batchId).sort((a, b) => a.seq - b.seq);
  const body = {
    roomId: String(payload.roomId || ''),
    probeId: String(payload.probeId || ''),
    startAt: String(payload.startAt || ''),
    endAt: payload.endAt === undefined ? null : (payload.endAt || null),
  };
  const check = legPayloadErrors(data, batch, body, legs, null);
  const errors = check.errors;
  let prevOpen = null;
  if (legs.length) {
    const prev = legs[legs.length - 1];
    if (body.startAt < prev.startAt) errors.startAt = '新段要接在第 ' + prev.seq + ' 段之后，开始时刻不能早于 ' + prev.startAt;
    if (prev.endAt === null) {
      // 上一段仍开放：默认在新段开始这一刻封段；需要并行交接可建段后再改前段封尾时刻
      prevOpen = prev;
    }
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '监测段没通过校验', errors);
  if (prevOpen) prevOpen.endAt = body.startAt;
  const leg = {
    id: store.nextId('lg', data.legs),
    batchId: batch.id,
    seq: legs.length + 1,
    roomId: body.roomId,
    probeId: body.probeId,
    startAt: body.startAt,
    endAt: body.endAt,
    handoffReason: String(payload.handoffReason || '').trim(),
    remark: String(payload.remark || '').trim(),
  };
  data.legs.push(leg);
  return decorateLegPub(data, leg, coldlib.timeline(data, batch.id));
}

function updateLeg(data, batchId, legId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const leg = data.legs.find((l) => l.id === legId && l.batchId === batchId);
  if (!leg) throw new AppError(404, 'LEG_NOT_FOUND', '这一段监测不存在');
  const legs = data.legs.filter((l) => l.batchId === batchId).sort((a, b) => a.seq - b.seq);
  const merged = Object.assign({}, leg, payload);
  const body = {
    roomId: String(merged.roomId || ''),
    probeId: String(merged.probeId || ''),
    startAt: String(merged.startAt || ''),
    endAt: merged.endAt === undefined || merged.endAt === '' ? null : merged.endAt,
  };
  const { errors } = legPayloadErrors(data, batch, body, legs, leg.id);
  const idx = legs.findIndex((l) => l.id === leg.id);
  const prev = legs[idx - 1];
  const next = legs[idx + 1];
  if (prev && body.startAt < prev.startAt) errors.startAt = '开始时刻不能早于上一段开始 ' + prev.startAt;
  if (next && body.startAt > next.startAt) errors.startAt = '开始时刻不能晚于下一段开始 ' + next.startAt;
  if (next && body.endAt === null) errors.endAt = '只有最后一段可以开放不填结束时刻';
  // 交接时允许旧段探头与新段并行一小段（段窗交叠），同一刻以序号靠后的新段为准，
  // 因此这里不限制前段结束必须早于后段开始；同一刻取谁由时间线口径决定。
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '监测段没通过校验', errors);
  Object.assign(leg, {
    roomId: body.roomId,
    probeId: body.probeId,
    startAt: body.startAt,
    endAt: body.endAt,
    handoffReason: payload.handoffReason !== undefined ? String(payload.handoffReason).trim() : leg.handoffReason,
    remark: payload.remark !== undefined ? String(payload.remark).trim() : leg.remark,
  });
  return decorateLegPub(data, leg, coldlib.timeline(data, batch.id));
}

function removeLeg(data, batchId, legId) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const legs = data.legs.filter((l) => l.batchId === batchId).sort((a, b) => a.seq - b.seq);
  const leg = legs.find((l) => l.id === legId);
  if (!leg) throw new AppError(404, 'LEG_NOT_FOUND', '这一段监测不存在');
  if (legs.length === 1) throw new AppError(409, 'LEG_LAST', '一批货至少要保留一段监测；不用的段可以改挂设备而不是删除');
  if (leg.seq !== legs[legs.length - 1].seq) throw new AppError(409, 'LEG_NOT_LAST', '只能从最后一段往前删，先删第 ' + legs[legs.length - 1].seq + ' 段');
  const tl = coldlib.timeline(data, batchId);
  const inWindow = tl.points.filter((p) => p.legId === leg.id).length;
  if (inWindow > 0) {
    throw new AppError(409, 'LEG_IN_USE', '这一段时间窗里还有 ' + inWindow + ' 条参与判定的温度记录，请先删除或移走这些记录再删段', { count: inWindow });
  }
  data.legs = data.legs.filter((l) => l.id !== leg.id);
  const last = data.legs.filter((l) => l.batchId === batchId).sort((a, b) => b.seq - a.seq)[0];
  if (last) last.endAt = null;
  return { removed: leg.id };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  return rows
    .map((r) => Object.assign({}, r, {
      batchCode: batchCode(data, r.batchId),
      probeCode: probeCode(data, r.probeId),
      outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  else if (probe.status === '停用') errors.probeId = '这台探头已停用，其记录不参与判定；请先给批次加挂新探头的监测段';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (batch && probe && probe.status !== '停用' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) {
    // 记录必须由该批该时段在册监测段的探头产生，否则会被时间线丢掉、算不进判定
    const at = String(payload.at);
    const legs = data.legs.filter((l) => l.batchId === batch.id);
    const inLeg = legs.find((l) => l.probeId === probe.id && l.startAt <= at && (l.endAt === null || l.endAt === '' || at <= l.endAt));
    if (!inLeg) {
      const windowLeg = legs.find((l) => l.startAt <= at && (l.endAt === null || l.endAt === '' || at <= l.endAt));
      errors.at = windowLeg
        ? '这个时刻该批在册探头是 ' + probeCode(data, windowLeg.probeId) + '，不是所选探头；换探头要先在批次详情登记新的监测段'
        : '这个时刻不在该批次任何监测段的时间窗内，请先在批次详情里补一段监测（换设备/换探头要先登记）';
    }
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  return { removed: id };
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  return rows
    .map((r) => Object.assign({}, r, { batchCode: batchCode(data, r.batchId) }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

// 放行：登记放行单并改批次状态
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    exemptGapCount: check.chain.exemptGapCount,
    legCount: check.legs.length,
    // 判定快照：哪一段、谁的设备、哪几条记录导致不过，交接豁免单列，便于台账追溯
    failed: check.failed,
    culprits: check.conditions
      .filter((c) => !c.ok)
      .map((c) => ({ key: c.key, text: c.text, value: c.value, limit: c.limit, items: c.culprits || [] })),
    exemptions: (check.conditions.find((c) => c.key === 'chain') || {}).exemptions || [],
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listLegs, createLeg, updateLeg, removeLeg,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
