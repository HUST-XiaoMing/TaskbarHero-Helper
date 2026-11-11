'use strict';

const fmt = n => n.toLocaleString('zh-CN', {maximumFractionDigits:0});

function eventEntry(now, event, gate, stages, time) {
  const start = Date.parse(event.startUtc), end = Date.parse(event.endUtc);
  const notes = [];
  if (!event.enabled || !Number.isFinite(start) || !Number.isFinite(end)) notes.push('活动未开放');
  else if (time < start) notes.push('活动尚未开始');
  else if (time >= end + 1000) notes.push('活动已结束');
  const closed = notes.length > 0;
  const prereq = stages.get(String(gate.unlockStageKey));
  const locked = !(now.allStageCounters[gate.unlockStageKey] > 0);
  if (locked) notes.push('需通关' + (prereq ? prereq.difficultyLabel + ' ' + prereq.label : '关卡 ' + gate.unlockStageKey));
  const qty = now.storedItemQuantities ? now.storedItemQuantities[gate.ticketKey] ?? 0 : null;
  if (qty == null) notes.push('门票待核实');
  else if (qty < gate.ticketAmount) notes.push('缺' + gate.ticketName);
  return {rank:closed ? 4 : locked ? 2 : notes.length ? 1 : 0, reason:notes[0], basis:[...notes,
    '每次耗票 ' + gate.ticketAmount + ' 张' + (qty == null ? '' : '，持有 ' + fmt(qty) + ' 张')].join(' · ')};
}

function petPlan(now, data, stages, observed, projected, requested, route, minRuns, minSeconds, time = Date.now()) {
  const empty = {pets:[], selectedPet:null, petPickKey:null, rows:[], xpPick:'暂无刷取推荐', goldPick:'—'};
  if (!data?.petUnlockSchema || !stages)
    return {...empty, note:'等待与当前游戏版本匹配的宠物表和关卡表。'};
  const owned = now.loadout?.unlockedPetKeys;
  const pets = Object.entries(data.pets).map(([key,p]) => {
    const unlocked = Array.isArray(owned) ? owned.includes(Number(key)) : null;
    const state = unlocked == null ? '状态未知' : unlocked ? '已解锁' : '未解锁';
    return {key, label:p.name + ' · ' + state, unlocked, pet:p};
  });
  const chosen = pets.find(p => p.key === String(requested)) ||
    pets.find(p => !p.unlocked && p.pet.unlock?.type === 'KillMonster') || pets[0];
  if (!chosen) return {...empty, note:'本版宠物表为空。'};
  const view = {...empty, pets:pets.map(({key,label}) => ({key,label})), selectedPet:chosen.key};
  const unlock = chosen.pet.unlock;
  if (unlock?.type === 'DLC')
    return {...view, xpPick:'支持者包宠物', goldPick:chosen.unlocked ? '已解锁' : '支持者包 DLC', note:'这只宠物由支持者包解锁。'};
  if (unlock?.type !== 'KillMonster' || !Number.isInteger(unlock.requiredKills) || !(unlock.requiredKills > 0))
    return {...view, note:'当前数据未收录可核实的刷取条件。'};

  const target = String(unlock.monsterKey), needed = unlock.requiredKills;
  const count = now.monsterKills ? (Object.hasOwn(now.monsterKills,target) ? now.monsterKills[target] : 0) : null;
  const progress = count == null ? '击杀进度待存档' : fmt(count) + ' / ' + fmt(needed);
  view.goldPick = chosen.unlocked ? '已解锁 · ' + unlock.monsterName :
    (count >= needed ? '已达解锁条件 · ' : '') + unlock.monsterName + ' ' + progress;
  const measured = new Map(observed.map(r => [r.key,r]));
  const times = new Map(projected.map(r => [r.key,r]));
  const events = new Map();
  for (const [id,event] of Object.entries(data.petEvents || {})) {
    for (const [key,gate] of Object.entries(event.stages)) events.set(key,{id,event,gate});
  }
  const rows = [];
  for (const stage of stages.values()) {
    const key = stage.key, entry = events.get(key);
    if (unlock.eventKey && String(unlock.eventKey) !== entry?.id) continue;
    const cleared = now.allStageCounters[key] > 0;
    const plague = stage.type === 'PLAGUE' && (cleared || key === String(now.stageKey));
    if (!entry && stage.type !== 'NORMAL' && !plague) continue;
    const weights = stage.mobWeights || {};
    const weight = weights[target] || 0, isBoss = String(stage.bossKey) === target;
    if (!weight && !isBoss) continue;
    const totalWeight = Object.values(weights).reduce((sum,w) => sum+w,0);
    const mobShare = totalWeight > 0 ? weight / totalWeight : 0;
    const perClear = stage.enemyCountEstimate * mobShare + Number(isBoss);
    if (!Number.isFinite(perClear) || perClear <= 0) continue;
    let access = {rank:0};
    if (entry) access = eventEntry(now,entry.event,entry.gate,stages,time);
    else if (plague) access = {rank:3, basis:'特殊来源 · 消耗污染度，入口有冷却'};
    else if (!cleared) access = {rank:2, basis:'尚无通关记录'};
    const obs = measured.get(key), estimate = times.get(key);
    const seconds = obs?.seconds ?? estimate?.seconds ?? null;
    const hasSample = obs?.killRuns >= minRuns && obs.killSeconds >= minSeconds;
    const actual = hasSample ? (obs.kills[target] || 0) * 3600 / obs.killSeconds : null;
    const rate = actual ?? (seconds > 0 ? perClear * 3600 / seconds : null);
    const basis = [];
    if (actual != null) basis.push('击杀实测 ' + (obs.killSeconds/60).toFixed(1) + ' 分');
    else if (obs?.seconds > 0) basis.push('怪池推算 · ' + (obs.robust ? '整轮中位' : obs.exact ? '整轮计时' : '波次计时'));
    else if (estimate) basis.push('怪池推算 · ' + estimate.basis);
    else basis.push('每轮推算 · 待计时');
    if (isBoss) basis.push('含 1 只关底目标');
    if (stage.estimateQuality === 'missing-monster' && !estimate?.basis.includes('缺项')) basis.push('怪池有缺项');
    if (access.basis) basis.push(access.basis);
    const name = plague ? stage.difficultyLabel + '瘟疫之地 · 强度 ' + stage.no :
      entry ? stage.difficultyLabel + ' · ' + entry.gate.name : route(key,stages);
    rows.push({key, route:name,
      mobShare, targetPerClear:perClear, targetPerHour:rate, seconds, basis:basis.join(' · '),
      availabilityRank:access.rank, reason:access.reason});
  }
  rows.sort((a,b) => a.availabilityRank - b.availabilityRank ||
    (b.targetPerHour ?? -1) - (a.targetPerHour ?? -1) || b.targetPerClear - a.targetPerClear || Number(a.key) - Number(b.key));
  const best = rows.find(r => r.availabilityRank === 0 && r.targetPerHour !== 0);
  const notes = ['击败' + unlock.monsterName + ' ' + fmt(needed) + ' 只可解锁' + chosen.pet.name + '。' +
    (!chosen.unlocked && count != null && count < needed ? '还差 ' + fmt(needed-count) + ' 只。' : '')];
  if (best) {
    view.xpPick = best.route;
    view.petPickKey = best.key;
    notes.push(best.targetPerHour == null ? '暂以每轮目标怪数量选图，取得本关计时后再比较每小时效率。' :
      '按每小时目标怪击杀数推荐；同配置有足够击杀实测时优先用实测，其他有计时的关用怪池和通关秒数推算。');
  } else view.xpPick = rows.find(r => r.reason)?.reason || '已验证可刷的关卡暂无有效路线';
  notes.push('小怪占比是目标怪在随机怪池中的权重。每轮按基础波数、每波怪数及同种关底首领估算。');
  const event = data.petEvents?.[unlock.eventKey];
  if (event) {
    const end = new Date(event.endUtc).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    notes.push('活动截至北京时间 ' + end + '。各难度检查 3-10 前置和对应门票，持票数含仓库。');
  } else notes.push('尚未通关的常规关与已探索的瘟疫关单列为来源参考。');
  return {...view,rows,note:notes.join('\n')};
}

module.exports = {petPlan};
