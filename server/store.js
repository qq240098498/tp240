const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  lowerLimitC: 2,
  upperLimitC: 8,
  allowExcursionMinutes: 30,
  allowTotalExcursionMinutes: 120,
  chainGapMinutes: 15,
  handoverGraceMinutes: 30,
  mktActivationEnergy: 83144,
  gasConstant: 8.314,
  probeCalibrationGraceDays: 0,
  recordIntervalMinutes: 15,
};

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  for (const key of ['rooms', 'probes', 'batches', 'records', 'legs', 'releases']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  migrateLegs(data);
  return data;
}

// 旧数据没有“监测段”：给每个批次补一条默认段，设备取批次所在冷库/车厢，
// 探头取这批最早一条记录的探头（没有记录就留空，等挂探头），从入库时刻起开放。
function migrateLegs(data) {
  const existing = new Set(data.legs.map((l) => l.batchId));
  const additions = [];
  for (const batch of data.batches) {
    if (existing.has(batch.id)) continue;
    const first = data.records
      .filter((r) => r.batchId === batch.id)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
    additions.push({
      id: nextId('lg', data.legs.concat(additions)),
      batchId: batch.id,
      seq: additions.length + 1,
      roomId: batch.roomId,
      probeId: first ? first.probeId : '',
      startAt: batch.loadedAt,
      endAt: null,
      handoffReason: '',
      remark: '系统补建的默认监测段',
    });
  }
  data.legs = data.legs.concat(additions);
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function round(n, digits) {
  const d = digits == null ? 2 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

function minutesBetween(a, b) {
  const toDate = (s) => new Date(String(s).replace(' ', 'T') + '+08:00');
  return Math.round((toDate(b) - toDate(a)) / 60000);
}

function nowText() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return now.getUTCFullYear() + '-' + p(now.getUTCMonth() + 1) + '-' + p(now.getUTCDate()) + ' ' + p(now.getUTCHours()) + ':' + p(now.getUTCMinutes()) + ':' + p(now.getUTCSeconds());
}

module.exports = { load, save, nextId, normalize, round, minutesBetween, nowText, DEFAULT_SETTINGS, dataFile };
