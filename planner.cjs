'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findGameInstall } = require('./game-install.cjs');
const { defaultSavePath, readSave, fingerprint } = require('./save-reader.cjs');
const { penalty, gamePenaltyV132, wikiModel } = require('./wiki-model.cjs');
const { equippedRows } = require('./equipment-details.cjs');
const { summarizeGear, applyGear, killExperience } = require('./gear-model.cjs');
const { petPlan } = require('./pet-planner.cjs');
const installDir = findGameInstall();
const dataIssues = new Set();

function currentCatalog(file, version, valid) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.gameVersion !== version || !data.sourceInstallDir ||
        path.relative(installDir, data.sourceInstallDir) !== '' || !valid(data) ||
        !data.sourceFiles?.['TaskBarHero_Data/sharedassets0.assets']) return null;
    for (const [relative, stamp] of Object.entries(data.sourceFiles)) {
      const stat = fs.statSync(path.join(installDir, relative), {bigint:true, throwIfNoEntry:false});
      if (!stat && stamp === null) continue;
      if (!stat || !stamp || Number(stat.size) !== stamp.size || String(stat.mtimeNs) !== stamp.mtimeNs) return null;
    }
    return data;
  } catch { return null; }
}

function loadLocalCatalog(fileName, extractor, label, valid) {
  if (!installDir) return null;
  const file = path.join(__dirname, 'data', fileName);
  let version;
  try { version = fs.readFileSync(path.join(installDir, 'Version.txt'), 'utf8').replace(/^\uFEFF/, '').trim(); }
  catch { dataIssues.add('无法读取游戏版本，请检查安装目录是否完整。'); return null; }
  const cached = currentCatalog(file, version, valid);
  if (cached) return cached;

  const runtimes = [['py.exe', ['-3']], ['python.exe', []]];
  const bundled = path.join(__dirname, 'runtime', 'python', 'python.exe');
  if (fs.existsSync(bundled)) runtimes.unshift([bundled, []]);
  for (const [command, prefix] of runtimes) {
    const result = spawnSync(command, [...prefix, '-B', '-X', 'utf8', path.join(__dirname,'tools',extractor),
      '--game-dir', installDir, '--out', file], {windowsHide:true, timeout:55000, encoding:'utf8'});
    if (result.error?.code === 'ENOENT' || [103,9009].includes(result.status)) continue;
    if (result.status === 0) {
      const generated = currentCatalog(file, version, valid);
      if (generated) return generated;
    }
    let message = label + '提取失败，请检查安装目录和游戏版本。';
    if (result.error?.code === 'ETIMEDOUT') message = label + '提取超时。';
    else if (/PermissionError|EACCES|Access is denied/i.test(result.stderr || ''))
      message = '无法读写' + label + '，请检查游戏和助手目录权限。';
    dataIssues.add(message);
    return null;
  }
  dataIssues.add('生成本地数据需要 Python 3.9 或更高版本，请安装 Python 或使用带运行环境的发布包。');
  return null;
}
const localData = loadLocalCatalog('game-stages.json', 'extract_stages.py', '关卡表',
  d => d.stageCatalogSchema === 2 && Array.isArray(d.stages) && d.stages.length);
const gearData = loadLocalCatalog('game-gear.json', 'extract_gear.py', '装备和宠物表', d => d.petUnlockSchema === 1);
const localStages = new Map((localData?.stages || []).map(s => [String(s.key), {
  ...s, key:String(s.key), name:s.name || ('关卡 ' + s.key),
  difficultyLabel:s.difficultyLabel || s.difficulty,
  label:s.label ?? (s.act + '-' + s.no)
}]));
const emptyStages = new Map();
function catalog(version) {
  return localData?.gameVersion === version && localStages.size ? localStages : emptyStages;
}
const stateDir = path.join(__dirname, 'state');
const stateFile = path.join(stateDir, 'history.json');
const finite = Number.isFinite;
const route = (key, map) => {
  const s = map.get(String(key));
  return s ? s.difficultyLabel + ' ' + s.label + ' · ' + s.name : '关卡 ' + key;
};
const heroName = (key, version) => (localData?.gameVersion === version && localData?.heroNames?.[key]) || ('英雄 ' + key);
const fm = n => n.toLocaleString('zh-CN', {maximumFractionDigits: 0});
const delta = (a, b) => finite(a) && finite(b) && b >= a ? b - a : null;

// Unlocking a pet can change every hero's rewards even if the visible pet stays the same.
function petPool(s) {
  const keys = s?.loadout?.unlockedPetKeys;
  return Array.isArray(keys) ? keys.slice().sort((a,b) => a-b).join(',') : null;
}

function recoverPetHistory(state, latest, directory) {
  const pool = petPool(latest);
  if (pool === null) return;
  const old = [...state.samples,...state.laps].filter(r => r.petPool === undefined && r.account === latest.accountId);
  if (!old.length) return;
  let since = Date.parse(latest.savedAt);
  const earliest = Math.min(...old.map(r => r.at - 1000*r.dt));
  const saves = fs.readdirSync(directory).filter(n => /^(Live_daily_\d{8}_\d{6}\.es3|SaveFile_Live_backup_\d{8}_\d{6}\.es3|SaveFile_Live_[1-5]\.es3\.bak)$/.test(n))
    .map(n => path.join(directory,n)).flatMap(file => {
      try { return [{file,at:fs.statSync(file).mtimeMs}]; } catch { return []; }
    }).sort((a,b) => b.at-a.at);
  for (const {file} of saves) {
    let snapshot;
    try { snapshot = readSave(file); } catch { continue; }
    if (snapshot.accountId !== latest.accountId) continue;
    if (snapshot.playSeconds > latest.playSeconds || petPool(snapshot) !== pool) break;
    since = Math.min(since, Date.parse(snapshot.savedAt));
    if (since <= earliest) break;
  }
  // A matching backup before a sample establishes that these pets were already unlocked.
  for (const row of old) row.petPool = row.at - 1000*row.dt >= since ? pool : null;
}

function interval(a, b) {
  if (!a || !a.accountId || a.accountId !== b.accountId || a.buildId !== b.buildId ||
      a.version !== b.version || a.stageKey !== b.stageKey || petPool(a) !== petPool(b)) return null;
  const dt = b.playSeconds - a.playSeconds;
  const wall = (Date.parse(b.savedAt) - Date.parse(a.savedAt)) / 1000;
  // A long offline gap, save rollback or time jump cannot be attributed to one route.
  if (!(dt > 0 && dt <= 600 && wall > 0 && Math.abs(wall - dt) <= Math.max(12, dt * 0.20))) return null;
  const runs = delta(a.stageCounter, b.stageCounter);
  if (runs === null || Object.entries(b.allStageCounters).some(([k, n]) =>
    k !== String(b.stageKey) && n !== (a.allStageCounters[k] || 0))) return null;
  if (finite(a.totalFails) && finite(b.totalFails) &&
      b.totalFails - a.totalFails !== b.stageFails - a.stageFails) return null;

  const xp = {};
  for (const hero of b.party) {
    const prev = a.party.find(h => h.key === hero.key);
    if (prev && prev.level === hero.level) xp[hero.key] = delta(prev.exp, hero.exp);
  }
  const stage = catalog(b.version).get(String(b.stageKey));
  let progress = null;
  if (stage && finite(a.stageWave) && finite(b.stageWave) &&
      Math.max(a.stageWave, b.stageWave) <= stage.waves && b.stageFails === a.stageFails) {
    const change = runs + (b.stageWave - a.stageWave) / stage.waves;
    if (change > 0) progress = change;
  }
  let kills = null;
  if (a.monsterKills && b.monsterKills) {
    kills = {};
    for (const key of new Set([...Object.keys(a.monsterKills), ...Object.keys(b.monsterKills)])) {
      const n = delta(Object.hasOwn(a.monsterKills,key) ? a.monsterKills[key] : 0,
        Object.hasOwn(b.monsterKills,key) ? b.monsterKills[key] : 0);
      if (n === null) { kills = null; break; }
      if (n > 0) kills[key] = n;
    }
  }
  return { account: b.accountId, build: b.buildId, version: b.version, petPool:petPool(b), key: b.stageKey, dt, xp, kills,
    gold: delta(a.goldEarned, b.goldEarned), runs, fails:delta(a.stageFails, b.stageFails), progress, at: Date.parse(b.savedAt) };
}

function ingest(state, snap) {
  const previous = state.current;
  if (previous && snap.savedAt === previous.savedAt && snap.playSeconds === previous.playSeconds &&
      snap.accountId === previous.accountId && snap.buildId === previous.buildId && snap.stageKey === previous.stageKey &&
      (petPool(previous) === null || petPool(previous) === petPool(snap))) {
    // Refresh the snapshot shape on upgrades without counting the last interval twice.
    state.current = snap;
    return;
  }
  // A restored older save starts a new observation series for this account.
  if (previous && previous.accountId === snap.accountId && snap.playSeconds < previous.playSeconds) {
    state.samples = state.samples.filter(s => s.account !== snap.accountId);
    state.laps = state.laps.filter(s => s.account !== snap.accountId);
  }
  const sample = interval(previous, snap);
  if (!sample) state.boundary = null;
  else state.samples.push(sample);
  if (snap.stageWave === 0) {
    const start = state.boundary;
    if (start && sample && snap.stageCounter > start.count) {
      state.laps.push({account: snap.accountId, build: snap.buildId, version: snap.version, petPool:petPool(snap),
        key: snap.stageKey, dt: snap.playSeconds - start.time, runs: snap.stageCounter - start.count,
        fails:delta(start.fails, snap.stageFails), at: Date.parse(snap.savedAt)});
    }
    // Duplicate end-of-run saves at wave zero should not shorten the following lap.
    if (!start || start.count !== snap.stageCounter)
      state.boundary = {count: snap.stageCounter, time: snap.playSeconds, fails:snap.stageFails};
  }
  state.current = snap;
}

function collect() {
  fs.mkdirSync(stateDir, {recursive: true});
  const lockPath = path.join(stateDir, 'history.lock');
  if (fs.existsSync(lockPath) && Date.now() - fs.statSync(lockPath).mtimeMs > 90000) fs.unlinkSync(lockPath);
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('另一个窗口正在读取存档，请稍候。'); throw e; }
  try {
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) :
      {current: null, samples: [], laps: [], boundary: null, liveStamp: ''};
    const live = defaultSavePath();
    const stat = fs.statSync(live);
    const stamp = stat.mtimeMs + '/' + stat.size;
    if (stamp === state.liveStamp && state.petSchema === 1 && petPool(state.current) !== null &&
        Object.hasOwn(state.current,'storedItemQuantities') && Object.hasOwn(state.current,'monsterKills') &&
        state.current.party.every(h => Array.isArray(h.equipment))) return state;
    const latest = readSave(live);
    if (state.petSchema !== 1 || state.current?.accountId !== latest.accountId) {
      recoverPetHistory(state,latest,path.dirname(live));
      state.petSchema = 1;
    }
    const prevAt = state.current ? Date.parse(state.current.savedAt) : 0;
    const endAt = Date.parse(latest.savedAt);
    const backups = [];
    for (let i = 1; i <= 5; i++) {
      const file = path.join(path.dirname(live), 'SaveFile_Live_' + i + '.es3.bak');
      try {
        const t = fs.statSync(file).mtimeMs;
        if (Math.floor(t) <= prevAt || Math.floor(t) >= endAt) continue;
        const snap = readSave(file);
        if (snap.accountId === latest.accountId && snap.playSeconds <= latest.playSeconds) backups.push(snap);
      } catch { /* A rotating backup may disappear between stat and read. */ }
    }
    backups.sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
    for (const snap of [...backups, latest]) ingest(state, snap);
    state.samples = state.samples.slice(-20000);
    state.laps = state.laps.slice(-8000);
    state.liveStamp = stamp;
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
    return state;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

function byRoute(state, hero) {
  const now = state.current;
  const pool = petPool(now);
  const matching = s => s.account === now.accountId && s.build === now.buildId && s.version === now.version &&
    (s.petPool ?? null) === pool;
  const groups = new Map();
  for (const s of state.samples.filter(matching)) {
    const key = String(s.key);
    const g = groups.get(key) || {key, dt: 0, xp: 0, xpTime: 0, gold: 0, goldTime: 0, runs: 0,
      progress: 0, progressTime: 0, lapRuns: 0, lapTime: 0, single:[], clean:[], fails:0, allFailsKnown:true,
      kills:{}, killSeconds:0, killRuns:0};
    groups.set(key, g);
    g.dt += s.dt;
    g.runs += s.runs;
    if (s.kills) {
      g.killSeconds += s.dt;
      g.killRuns += s.runs;
      for (const [id,n] of Object.entries(s.kills)) g.kills[id] = (g.kills[id] || 0) + n;
    }
    if (finite(s.fails)) g.fails += s.fails;
    else g.allFailsKnown = false;
    if (finite(s.xp[hero.key])) { g.xp += s.xp[hero.key]; g.xpTime += s.dt; }
    if (finite(s.gold)) { g.gold += s.gold; g.goldTime += s.dt; }
    if (finite(s.progress)) { g.progress += s.progress; g.progressTime += s.dt; }
  }
  for (const s of state.laps.filter(matching)) {
    const g = groups.get(String(s.key));
    if (g && s.dt > 0 && s.runs > 0) {
      g.lapRuns += s.runs;
      g.lapTime += s.dt;
      if (s.runs === 1 && !(s.fails > 0)) {
        g.single.push(s.dt);
        if (s.fails === 0) g.clean.push(s.dt);
      }
    }
  }
  return [...groups.values()].map(g => {
    const exact = g.lapRuns > 0;
    const singles = g.clean.length >= 3 ? g.clean : g.single;
    const robust = singles.length >= 3;
    let seconds = exact ? g.lapTime / g.lapRuns : g.runs > 0 && g.progress >= 0.2 ? g.progressTime / g.progress : null;
    if (robust) {
      singles.sort((a,b) => a-b);
      const middle = Math.floor(singles.length / 2);
      seconds = singles.length % 2 ? singles[middle] : (singles[middle-1] + singles[middle]) / 2;
    }
    return {key:g.key, route:route(g.key, catalog(now.version)), runs:g.runs, seconds, exact, robust, sampledSeconds:g.dt,
      fails:g.allFailsKnown ? g.fails : null, knownFails:g.fails, xpSeconds:g.xpTime, goldSeconds:g.goldTime,
      kills:g.kills, killSeconds:g.killSeconds, killRuns:g.killRuns,
      xp: g.xpTime > 0 ? 3600 * g.xp / g.xpTime : null,
      gold: g.goldTime > 0 ? 3600 * g.gold / g.goldTime : null,
      basis: '采样 ' + (g.dt / 60).toFixed(1) + ' 分' + (seconds ? (robust ? ' · 整轮中位' : exact ? ' · 整轮' : ' · 波次折算') : '')};
  });
}

function project(observed, now, hero, gear = summarizeGear(now, hero.key, gearData), includeUncleared = false) {
  const map = catalog(now.version);
  if (!map.size) return {rows:[], note:''};
  const timed = observed.filter(r => {
    const stage = map.get(r.key);
    return r.seconds > 0 && stage?.type === 'NORMAL' && stage.hpEstimate > 0 && stage.waves > 0;
  });
  if (!timed.length) return {rows:[], note:'保持同一配置刷完一关，等待游戏自动保存后即可建立时间基准。'};
  const strong = timed.filter(r => r.robust);
  const anchors = (strong.length ? strong : timed).map(r => ({stage:map.get(r.key), seconds:r.seconds}));
  const fit = wikiModel(anchors);
  // With one point a nonnegative HP + waves model admits a range. Use its slow endpoint.
  const base = anchors.reduce((x, y) => x.stage.hpEstimate > y.stage.hpEstimate ? x : y);
  const upper = s => Math.max(1, base.seconds * Math.max(s.hpEstimate / base.stage.hpEstimate, s.waves / base.stage.waves));
  const rows = [...map.values()].filter(s => s.type === 'NORMAL' && (includeUncleared || now.allStageCounters[s.key] > 0) &&
    [s.xpEstimate,s.goldEstimate,s.hpEstimate,s.waves].every(v => finite(v) && v > 0)).map(s => {
    const obs = timed.find(r => r.key === s.key);
    const seconds = obs?.seconds ?? (fit ? fit(s) : upper(s));
    const expFactor = now.version === '1.3.2' ? gamePenaltyV132(hero.level, s.level) : penalty(hero.level, s.level);
    const reward = applyGear(s,expFactor,gear,map === localStages ? localData : null);
    const missing = s.estimateQuality === 'missing-monster';
    return {route:route(s.key,map), key:s.key, seconds, runs:obs?.runs ?? null,expFactor,
      xp: 3600 * reward.xpPerClear / seconds,
      gold: 3600 * reward.goldPerClear / seconds,
      basis: (obs ? (obs.robust ? '整轮中位' : obs.exact ? '整轮计时' : '波次折算') : fit ? anchors.length + ' 关拟合' : '单点保守推算') +
        (missing ? ' · 怪物配置有缺项' : '')};
  });
  const model = fit ? anchors.length + ' 个不同关卡提供用时基准。' :
    '用' + route(base.stage.key,map) + '作单点保守推算，第二关累计 3 个完整单轮后可重新拟合。';
  const incomplete = anchors.some(a => a.stage.estimateQuality === 'missing-monster');
  return {rows, note:model + (strong.length ? '' : ' 当前校准样本较短。') +
    (incomplete ? ' 计时基准关的怪物表有缺项，跨关推算也受影响。' : '') +
    (gear.modeled && map === localStages ? (gear.incomplete || gear.goldIncomplete ?
      ' 部分属性尚未核实，推算只计已确认的加成。' : ' 已按当前英雄和账号已核实的加成逐怪结算。') : ' 当前使用基础奖励估算。')};
}

const minRuns = 3;
const minRewardSeconds = 120;

function qualified(row, metric) {
  return row && finite(row[metric]) && row.runs >= minRuns && row[metric + 'Seconds'] >= minRewardSeconds;
}

function samplingProgress(row, metric) {
  if (!row) return '等待首段有效采样';
  if (qualified(row,metric)) return null;
  const runsLeft = Math.max(0,minRuns - row.runs);
  const secondsLeft = Math.max(0,Math.ceil(minRewardSeconds - row[metric + 'Seconds']));
  const remaining = [];
  if (runsLeft) remaining.push(runsLeft + ' 次通关');
  if (secondsLeft) remaining.push(secondsLeft + ' 秒有效采样');
  return '已通关 ' + row.runs + ' 次 · 还差 ' + remaining.join('、');
}

function plan(observed, projection, now, metric) {
  const measured = new Map(observed.map(r => [r.key, r]));
  const savedStageKey = String(now.stageKey);
  const sampleProgress = samplingProgress(measured.get(savedStageKey),metric);
  const tested = observed.filter(r => qualified(r, metric)).sort((a,b) => b[metric] - a[metric]);
  let best = tested[0];
  // Only use a known failure rate as the tie-breaker. Old history lacks failure deltas.
  if (best?.fails > 0) {
    const failureRate = r => r.fails / (r.runs + r.fails);
    const similar = tested.filter(r => r[metric] >= best[metric] * 0.95 && r.fails !== null);
    similar.sort((a,b) => failureRate(a) - failureRate(b) || b[metric] - a[metric]);
    best = similar[0];
  }
  const rows = projection.rows.map(r => {
    const obs = measured.get(r.key);
    return {...r, measuredXp:obs?.xp ?? null, measuredGold:obs?.gold ?? null,
      runs:obs?.runs ?? null, fails:obs?.fails ?? null, basis:r.basis + (obs ? ' · ' + (obs.sampledSeconds / 60).toFixed(1) + ' 分实测' : '')};
  });
  const testedModel = rows.find(r => r.key === best?.key);
  const candidates = rows.filter(r => {
    const obs = measured.get(r.key);
    return !qualified(obs,metric) && !(obs?.knownFails >= 3 && !obs.runs) &&
      (!testedModel || r[metric] >= 0.90 * testedModel[metric]);
  }).sort((a,b) => b[metric] - a[metric]);
  const leader = candidates[0];
  // Finish an in-progress competitive trial instead of switching during its first few waves.
  const next = candidates.find(r => r.key === savedStageKey && measured.has(r.key) &&
    r[metric] >= leader[metric] * 0.90) || leader;
  const unit = metric === 'gold' ? '金币' : '经验';
  const lines = [];
  const notes = [];
  if (best) lines.push('同配置实测基准 ' + fm(best[metric]) + ' ' + unit + '/小时。');
  if (next) {
    if (best) lines.push('试刷目标：每分钟实得超过 ' + fm(best[metric]/60) + ' ' + unit + '，失败和重开也计时。');
    const close = candidates.find(r => r.key !== next.key && r[metric] >= 0.90 * leader[metric]);
    if (close) notes.push(close.route + ' 也在候选前列（推算相差不超过 10%）。');
    notes.push('同配置通关 ' + minRuns + ' 次、有效采样满 ' + minRewardSeconds + ' 秒后参与比较。');
  } else if (best) notes.push('可在' + best.route + '继续挂机。');
  if (tested.length === 1) notes.push('目前仅一关实测达标。');
  if (metric === 'gold') notes.push('实测金币含同一时段的其他收入。');
  // Measured routes absent from the model (e.g. a special stage) still belong in the plan.
  const modeledKeys = new Set(rows.map(r => r.key));
  for (const obs of observed.filter(r => !modeledKeys.has(r.key))) {
    rows.push({...obs, xp:null, gold:null, expFactor:null, measuredXp:obs.xp, measuredGold:obs.gold});
  }
  return {rows, farmStageKey:best?.key ?? null, trialStageKey:next?.key ?? null, sampleProgress,
    xpPick:best?.route ?? (route(savedStageKey,catalog(now.version)) + ' · ' + sampleProgress),
    goldPick:next?.route ?? (best ? '暂无其他试刷候选' : '等待同队伍的通关计时'),
    note:[...lines, notes.join(' '), projection.note].filter(Boolean).join('\n')};
}

function liveXpProfile(now, hero, gear) {
  if (!hero || !now.accountId || !now.buildId || now.version !== '1.3.2' ||
      localData?.gameVersion !== now.version || !gear.modeled || gear.incomplete) return null;
  // The equipment model does not resolve effects from an equipped reliquary.
  const slots = now.loadout?.relicSlots;
  if (!Array.isArray(slots) || slots.some(s => !s.holder || s.holder.itemKey || s.holder.missing ||
      !Array.isArray(s.relics) || s.relics.some(r => r.itemKey || r.missing))) return null;

  const stage = localStages.get(String(now.stageKey));
  if (stage?.type !== 'NORMAL') return null;
  const level = localData.levelMultipliers?.[stage.level];
  const factor = gamePenaltyV132(hero.level, stage.level);
  const bossKey = Number(stage.bossKey);
  const boss = localData.monsters?.[bossKey];
  if (!finite(factor) || !finite(level?.MonsterExpMultiplier) || !Number.isInteger(bossKey) ||
      !finite(boss?.RewardExp) || !finite(stage.bossMultipliers?.BossExpMultiplier)) return null;
  const bossXp = killExperience(boss,level,stage.bossMultipliers,factor,gear);
  const normalXp = {};
  for (const key of stage.mobKeys || []) {
    const monster = localData.monsters?.[key];
    if (!finite(monster?.RewardExp)) continue;
    const xp = killExperience(monster,level,null,factor,gear);
    if (!finite(xp) || xp < 0) return null;
    normalXp[key] = xp;
  }
  if (!finite(bossXp) || bossXp < 0 || !Object.keys(normalXp).length) return null;
  const profileId = fingerprint('live-kill-xp-v1', now.version, now.accountId, now.buildId,
    petPool(now), now.stageKey, hero.key, hero.level, normalXp, bossKey, bossXp);
  return {stageKey:Number(now.stageKey), heroKey:Number(hero.key), heroName:heroName(hero.key, now.version),
    profileId, bossKey, normalXp, bossXp};
}

function report(state, mode, heroKey, goal = 'xp', petKey = null, petAccount = null) {
  const now = state.current;
  const heroes = now.party.map(h => ({key:String(h.key), label:heroName(h.key, now.version) + ' Lv.' + h.level}));
  const hero = now.party.find(h => String(h.key) === String(heroKey)) || now.party[0];
  const observed = hero ? byRoute(state, hero) : [];
  const metric = goal === 'gold' ? 'gold' : 'xp';
  const gear = summarizeGear(now, hero?.key, gearData);
  const matchingGearData = gearData?.gameVersion === now.version ? gearData : null;
  const gearItems = equippedRows(hero,matchingGearData);
  const gearText = [];
  if (hero) {
    gearText.push(heroName(hero.key, now.version) + ' Lv.' + hero.level + ' · 已识别穿戴 ' +
      (hero.equipment || []).filter(e => e.itemKey).length + ' 件');
    if (gear.modeled) {
      gearText.push('经验：装备加成 ' + (gear.xpPermille / 10) + '%，符文和已解锁宠物加成 ' +
        (gear.accountXpPermille / 10) + '%。合计倍率 ×' + Number(gear.xpMultiplier.toFixed(4)) +
        '，小怪 / 关底 Boss 的固定经验分别为 ' + gear.normalXpFlat + ' / ' + gear.bossXpFlat + '（乘倍率前）。');
      gearText.push('金币：账号倍率 ×' + Number(gear.goldMultiplier.toFixed(4)) + '，小怪 / 关底 Boss 的固定金币分别为 ' +
        gear.normalGoldFlat + ' / ' + gear.bossGoldFlat + '（乘倍率后）。');
      if (gear.incomplete || gear.goldIncomplete) gearText.push('部分穿戴或奖励属性尚未核实，本页只计可确定的贡献。');
    } else gearText.push('当前版本或配置的个人奖励参数不完整。');
    const skills = (hero.skillKeys || []).map(k => matchingGearData?.skills?.[k]?.name || ('#' + k));
    if (skills.length) gearText.push('出战技能：' + skills.join('、'));
  }
  const source = [];
  if (!installDir) source.push('请在“游戏目录”中选择 TaskBarHero 安装目录。当前可查看存档实测收益。');
  if (localData && localData.gameVersion !== now.version)
    source.push('游戏安装版本 ' + localData.gameVersion + ' 与存档版本 ' + now.version + ' 不一致，请在游戏中保存一次。');
  if ((mode === 'plan' || mode === 'wiki') && catalog(now.version).size)
    source.push('本机关卡表 v' + now.version + (now.version === '1.3.2' ? '。' : '，等级系数暂按 Wiki 公式估算。'));
  source.push(...dataIssues);
  const projection = hero && mode !== 'measured' ? project(observed,now,hero,gear,mode === 'pet') : {rows:[],note:''};
  const selectionAccount = now.accountId ?? '0';
  const view = mode === 'plan' ? plan(observed,projection,now,metric) :
    mode === 'pet' ? petPlan(now, matchingGearData, localData?.gameVersion === now.version ? localStages : null,
      observed, projection.rows, petAccount && petAccount !== selectionAccount ? null : petKey, route, minRuns, minRewardSeconds) :
    mode === 'wiki' ? projection : {rows:observed,
    note:'本表显示当前配置采过样的关卡。在「模型推算」可查看其余已通关的刷图候选。经验按所选英雄的增量计算，金币含同期其他来源。'};
  const pick = metric => {
    let eligible = view.rows.filter(r => finite(r[metric]));
    if (!eligible.length) return '等待读取有效样本';
    if (mode !== 'wiki') {
      const stable = eligible.filter(r => qualified(r,metric));
      if (!stable.length) return '采样中 · 建议各刷满 3 次';
      eligible = stable;
    }
    eligible.sort((a,b) => b[metric] - a[metric]);
    return eligible[0].route + (eligible.length === 1 ? '（仅一关达标）' : '');
  };
  const date = new Date(now.savedAt);
  return {ok:true, gameInstallDir:installDir, message:'已读取游戏存档', updated:date.toLocaleString('zh-CN',{hour12:false}),
    pets:view.pets, selectedPet:view.selectedPet, petPickKey:view.petPickKey, petAccount:mode === 'pet' ? selectionAccount : undefined,
    savedStageKey:String(now.stageKey), farmStageKey:view.farmStageKey ?? null, trialStageKey:view.trialStageKey ?? null,
    sampleProgress:view.sampleProgress ?? null,
    location:route(now.stageKey,catalog(now.version)), party:heroes.map(h => h.label).join('  /  '),
    gold:finite(now.gold) ? fm(now.gold) : '—', version:now.version, xpPick:view.xpPick ?? pick('xp'), goldPick:view.goldPick ?? pick('gold'),
    note:[...source, view.note].filter(Boolean).join(' '),
    rows:view.rows, heroes, gearItems, gearSummary:gearText.join('\n'), selectedHero:hero ? String(hero.key) : '',
    liveXpProfile:liveXpProfile(now,hero,gear)};
}

module.exports = {interval, ingest, byRoute, project, report, collect};
if (require.main === module) {
  const arg = name => process.argv.indexOf(name) < 0 ? null : process.argv[process.argv.indexOf(name) + 1];
  try { console.log(JSON.stringify(report(collect(), arg('--mode') ?? 'plan', arg('--hero'), arg('--goal'), arg('--pet'), arg('--pet-account')))); }
  catch (error) {
    console.log(JSON.stringify({ok:false, gameInstallDir:installDir, note:[...dataIssues].join(' '),
      message:error.code === 'ENOENT' && error.path === defaultSavePath() ? '未找到《TBH: 塔斯克巴·英雄》存档，请在游戏内保存一次。' : error.message}));
  }
}
