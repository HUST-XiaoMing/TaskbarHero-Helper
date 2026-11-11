'use strict';

// Local v1.3.2 online kill rewards. Flat XP is added after the level penalty;
// the hero's XP multiplier and the account's XP bonus add to one another.
// GameAssembly: Hero.hbf (0xE1A570), xs.lix (0xA6FE20), bcr.mrv (0xB66E20).
const finite = Number.isFinite;

function accountBonuses(loadout, data) {
  const totals = {};
  let incomplete = !Array.isArray(loadout.runes) || !Array.isArray(loadout.unlockedPetKeys);
  const add = entry => {
    if (entry && finite(entry.value)) totals[entry.stat] = (totals[entry.stat] || 0) + entry.value;
    else incomplete = true;
  };
  for (const rune of loadout.runes || []) {
    const levels = data.runes?.[rune.key]?.levels;
    if (!levels || !Number.isInteger(rune.level) || rune.level < 1) {
      incomplete = true;
      continue;
    }
    const learned = Object.keys(levels).filter(level => Number(level) >= 1 && Number(level) <= rune.level);
    if (learned.length !== rune.level) incomplete = true;
    for (const level of learned) add(levels[level]);
  }
  // Pet ownership and the currently displayed pet are separate save fields.
  for (const key of new Set(loadout.unlockedPetKeys || [])) {
    const petStats = data.pets?.[key]?.stats;
    if (!Array.isArray(petStats)) incomplete = true;
    for (const entry of petStats || []) {
      if (entry.mod === 'FLAT') add(entry);
      else if (/Exp|Gold/.test(entry.stat)) incomplete = true;
    }
  }
  // These account modifiers change encounter counts. Do not present the base-wave
  // expectation as a complete account prediction in a build where they are active.
  if (totals.WaveCountReduction || totals.WaveMonsterAmount) incomplete = true;
  return {totals,incomplete};
}

function readModifiers(hero, data) {
  const stats = [];
  let incomplete = false;
  let count = 0;
  for (const item of hero.equipment) {
    if (!item.itemKey) {
      if (item.missing) incomplete = true;
      continue;
    }
    count++;
    const definition = data.items?.[item.itemKey];
    if (!definition || item.chaotic) incomplete = true;
    else stats.push(...(definition.stats || []));
    for (const affix of item.affixes || []) {
      // The instance's recorded stat and mod override recipe defaults.
      const template = data.affixes?.[affix.statModKey];
      const stat = affix.statType == null ? template?.stat : data.statIds?.[affix.statType];
      const mod = affix.modType == null ? template?.mod : data.modIds?.[affix.modType];
      if (stat && mod && finite(affix.value)) stats.push({stat,mod,value:affix.value});
      else incomplete = true;
    }
    if (item.relic) incomplete = true;
  }
  return {stats,count,incomplete};
}

// The stat calculator (0xB61290) applies the sum of flat terms, then the sum
// of additive percentages, then each multiplicative percentage independently.
function statValue(stats, stat, base, flatDivisor) {
  let flat = base, add = 0, multi = 1;
  for (const term of stats) {
    if (term.stat !== stat || !finite(term.value)) continue;
    if (term.mod === 'FLAT') flat += term.value / flatDivisor;
    if (term.mod === 'ADDITIVE') add += term.value / 1000;
    if (term.mod === 'MULTIPLICATIVE') multi *= 1 + term.value / 1000;
  }
  return flat * (1 + add) * multi;
}

function summarizeGear(now, heroKey, data) {
  const hero = now?.party?.find(h => String(h.key) === String(heroKey));
  if (now?.version !== '1.3.2' || data?.gameVersion !== now.version || !Array.isArray(hero?.equipment) || !now.loadout) {
    return {modeled:false, incomplete:true, goldIncomplete:true, equippedCount:0, heroKey};
  }
  const owned = readModifiers(hero,data);
  const account = accountBonuses(now.loadout,data);
  const {totals} = account;
  const teamGoldUnknown = now.party.some(h => {
    if (!Array.isArray(h.equipment)) return true;
    const gear = h === hero ? owned : readModifiers(h,data);
    return gear.incomplete || gear.stats.some(e => e.stat === 'GoldAmount' && e.value !== 0);
  });
  const accountXpPermille = totals.IncreaseExpAmount || 0;
  const accountGoldPermille = totals.IncreaseGoldAmount || 0;
  const heroFactor = statValue(owned.stats, 'IncreaseExpAmount', 1, 1000);
  const xpFlat = Math.trunc(statValue(owned.stats, 'AdditionalExp', 0, 1));
  const commonXp = (totals.AdditionalExp || 0) + xpFlat;
  const commonGold = totals.AdditionalGold || 0;
  return {
    modeled:true, heroKey:hero.key, equippedCount:owned.count, incomplete:owned.incomplete || account.incomplete,
    goldIncomplete:teamGoldUnknown || account.incomplete,
    xpPermille:Number(((heroFactor - 1) * 1000).toFixed(6)), xpFlat,
    accountXpPermille, accountGoldPermille, xpMultiplier:Math.max(1, heroFactor + accountXpPermille / 1000),
    goldMultiplier:1 + Math.max(0,accountGoldPermille) / 1000,
    normalXpFlat:commonXp + (totals.AdditionalExpNormalMonster || 0),
    bossXpFlat:commonXp + (totals.AdditionalExpStageBoss || 0),
    normalGoldFlat:commonGold + (totals.AdditionalGoldNormalMonster || 0),
    bossGoldFlat:commonGold + (totals.AdditionalGoldStageBoss || 0)
  };
}

function killExperience(monster, level, boss, expFactor, gear) {
  const baseXp = monster.RewardExp * level.MonsterExpMultiplier * (boss?.BossExpMultiplier ?? 1000) / 1000000;
  return (baseXp * expFactor + (boss ? gear.bossXpFlat : gear.normalXpFlat)) * gear.xpMultiplier;
}

function killReward(monster, level, boss, expFactor, gear) {
  const baseGold = Math.floor(monster.RewardGold * level.MonsterGoldMultiplier * (boss?.BossGoldMultiplier ?? 1000) / 1000000);
  return {
    xp:killExperience(monster, level, boss, expFactor, gear),
    // Account gold (0xB670A0) uses integer percentage arithmetic before flat awards.
    gold:baseGold + Math.floor(baseGold * Math.max(0,gear.accountGoldPermille) / 1000) +
      (boss ? gear.bossGoldFlat : gear.normalGoldFlat)
  };
}

function applyGear(stage, expFactor, gear, stageData) {
  const base = {xpPerClear:finite(stage?.xpEstimate) && finite(expFactor) ? stage.xpEstimate * expFactor : null,
    goldPerClear:stage?.goldEstimate ?? null, modeled:false};
  if (!gear?.modeled || !finite(expFactor) || stageData?.gameVersion !== '1.3.2' || stage?.type !== 'NORMAL') return base;
  const level = stageData.levelMultipliers?.[stage.level];
  const boss = stageData.monsters?.[stage.bossKey];
  const pool = Object.entries(stage.mobWeights || {});
  const weightSum = pool.reduce((sum, entry) => sum + entry[1],0);
  if (!level || !boss || !weightSum || !finite(stage.enemyCountEstimate)) return base;
  const end = killReward(boss,level,stage.bossMultipliers,expFactor,gear);
  let xp = end.xp, gold = end.gold;
  for (const [key, weight] of pool) {
    const monster = stageData.monsters[key];
    if (!monster) continue; // Same missing-slot hypothesis as the native stage-table extraction.
    const amount = stage.enemyCountEstimate * weight / weightSum;
    const award = killReward(monster,level,null,expFactor,gear);
    xp += amount * award.xp;
    gold += amount * award.gold;
  }
  return {xpPerClear:xp, goldPerClear:gold, modeled:true};
}

module.exports = {summarizeGear, applyGear, killExperience};
