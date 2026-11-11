'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Public single-player ES3 format used by WcgStark/tbh-farm (app/index.html).
const es3FormatKey = 'emuMqG3bLYJ938ZDCfieWJ';
const maxBytes = 64 * 1024 * 1024;

function defaultSavePath() {
  return path.join(os.homedir(), 'AppData', 'LocalLow', 'TesseractStudio', 'TaskbarHero', 'SaveFile_Live.es3');
}

function fingerprint(...values) {
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
}

function parseRecord(input) {
  if (input && typeof input === 'object') return input;
  // Skip quoted strings. Item instance IDs and tick values can exceed Number.MAX_SAFE_INTEGER.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  const text = String(input).replace(tokens, token =>
    /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token
  );
  return JSON.parse(text);
}

function loadRecord(bytes) {
  if (bytes.length < 32 || bytes.length % 16 !== 0) throw new Error('存档尚未写完或格式不受支持。');
  try {
    const iv = bytes.subarray(0, 16);
    const key = crypto.pbkdf2Sync(es3FormatKey, iv, 100, 16, 'sha1');
    const cipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let plain = Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]);
    if (plain[0] === 0x1f && plain[1] === 0x8b) {
      plain = zlib.gunzipSync(plain, { maxOutputLength: maxBytes });
    }
    const envelope = JSON.parse(plain.toString('utf8').replace(/^\uFEFF/, ''));
    const player = parseRecord(envelope.PlayerSaveData.value);
    const account = parseRecord(envelope.AccountSaveData?.value ?? {});
    return { player, owner: account.ownerSteamId || account.playerId || null };
  } catch {
    // JSON parse errors can quote nearby private data. Return a generic format error.
    throw new Error('暂时无法解析存档，游戏可能正在保存，或存档格式已经更新。');
  }
}

function nonnegative(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function buildFingerprint(player, heroes, items) {
  function equipment(id) {
    const item = items.get(String(id));
    if (!item) return id;
    const stats = [id, item.ItemKey, item.IsChaotic, item.EnchantData];
    if (item.RelicData) stats.push(item.RelicData);
    return stats;
  }
  const party = heroes.map(h => [
    h.heroKey, h.HeroLevel, (h.equippedItemIds ?? []).map(equipment), h.equippedSKillKey
  ]);
  const upgrades = (rows, key) => (rows ?? []).filter(r => r.Level > 0)
    .map(r => [r[key], r.Level]).sort((a, b) => a[0] - b[0]);
  const relics = (player.relicEquipSaveData?.ReliquarySlots ?? [])
    .map(slot => [equipment(slot.ReliquaryUid), (slot.RelicUids ?? []).map(equipment)]);
  return fingerprint('build-v1', party, player.commonSaveData.ArrangedPetKey,
    upgrades(player.RuneSaveData, 'RuneKey'), upgrades(player.attributeSaveDatas, 'Key'), relics);
}

function statValue(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function wornItem(items, id, slot) {
  const result = { slot, itemKey: null, chaotic: false, affixes: [] };
  if (id == null || String(id) === '0' || id === '') return result;
  const item = items.get(String(id));
  if (!item || !nonnegative(item.ItemKey)) return { ...result, missing: true };
  result.itemKey = Number(item.ItemKey);
  result.chaotic = item.IsChaotic === true;
  for (const [index, affix] of (item.EnchantData ?? []).entries()) {
    if (!affix || !(affix.StatModKey > 0 || affix.StatType > 0 || affix.Value)) continue;
    result.affixes.push({
      slot: index, statModKey: nonnegative(affix.StatModKey), statType: nonnegative(affix.StatType),
      modType: nonnegative(affix.ModType), recipeType: nonnegative(affix.RecipeType),
      tier: nonnegative(affix.Tier), value: statValue(affix.Value)
    });
  }
  if (item.RelicData) {
    result.relic = {
      statModKey: nonnegative(item.RelicData.StatModKey), tier: nonnegative(item.RelicData.StatTier),
      value: statValue(item.RelicData.Value), attunementCount: nonnegative(item.RelicData.AttunementCount)
    };
  }
  return result;
}

function learned(rows, keyField) {
  return (rows ?? []).filter(r => r[keyField] > 0 && r.Level > 0)
    .map(r => ({ key: Number(r[keyField]), level: Number(r.Level) }));
}

function storedItemQuantities(player, items) {
  const containers = [player.inventorySaveDatas, player.stashSaveDatas, player.materialStashSaveDatas];
  if (!Array.isArray(player.itemSaveDatas) || !containers.every(Array.isArray)) return null;
  const totals = {};
  for (const slots of containers) {
    for (const slot of slots) {
      if (!slot) return null;
      const quantity = nonnegative(slot.Quantity);
      // An empty bag or stash slot can retain the previous stack size.
      if (quantity === 0 || (slot.ItemKey == null && String(slot.ItemUniqueId) === '0')) continue;
      const key = nonnegative(slot.ItemKey ?? items.get(String(slot.ItemUniqueId))?.ItemKey);
      if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(key) || key < 1) return null;
      totals[key] = (totals[key] || 0) + quantity;
      if (!Number.isSafeInteger(totals[key])) return null;
    }
  }
  return totals;
}

function summarize(bytes, savedAt) {
  const { player, owner } = loadRecord(bytes);
  const common = player.commonSaveData;
  if (!common || !Array.isArray(common.arrangedHeroKey) || !Array.isArray(player.heroSaveDatas)) {
    throw new Error('缺少队伍或进度信息，当前存档结构尚不受支持。');
  }
  const heroMap = new Map(player.heroSaveDatas.map(h => [Number(h.heroKey), h]));
  const heroes = common.arrangedHeroKey.filter(key => Number(key) > 0).map(key => heroMap.get(Number(key)));
  if (heroes.some(h => !h || !nonnegative(h.HeroLevel))) throw new Error('出战英雄数据不完整。');
  const rows = (player.aggregateSaveDatas ?? []).filter(r => Number(r.Content ?? 0) === 0);
  const aggregate = (type, key) => nonnegative(rows.find(r => r.Type === type && r.SubKey === key)?.Value);
  const keyedTotals = type => Object.fromEntries(rows.filter(r => r.Type === type && r.SubKey > 0)
    .map(r => [r.SubKey, nonnegative(r.Value)]));
  const stageKey = nonnegative(common.currentStageKey);
  const playSeconds = nonnegative(common.playTime);
  if (stageKey === null || playSeconds === null) throw new Error('缺少当前关卡或游戏时长。');
  const allStageCounters = keyedTotals(13);
  // Long item-instance identifiers are used only to resolve the equipped item locally.
  const items = new Map((player.itemSaveDatas ?? []).map(item => [String(item.UniqueId), item]));
  return {
    savedAt,
    version: String(common.version ?? ''),
    accountId: owner ? fingerprint('account-v1', os.homedir(), String(owner)) : null,
    buildId: buildFingerprint(player, heroes, items),
    party: heroes.map(h => ({
      key: Number(h.heroKey), level: Number(h.HeroLevel), exp: nonnegative(h.HeroExp),
      equipment: (h.equippedItemIds ?? []).map((id, slot) => wornItem(items, id, slot)),
      skillKeys: (h.equippedSKillKey ?? []).filter(key => key > 0).map(Number)
    })),
    loadout: {
      petKey: nonnegative(common.ArrangedPetKey),
      unlockedPetKeys: Array.isArray(player.PetSaveData) ? player.PetSaveData
        .filter(pet => pet.IsUnlock === true && pet.PetKey > 0).map(pet => Number(pet.PetKey)) : null,
      runes: learned(player.RuneSaveData, 'RuneKey'),
      attributes: learned(player.attributeSaveDatas, 'Key'),
      relicSlots: (player.relicEquipSaveData?.ReliquarySlots ?? []).map((r, slot) => ({
        holder: wornItem(items, r.ReliquaryUid, slot),
        relics: (r.RelicUids ?? []).map((id, index) => wornItem(items, id, index))
      }))
    },
    stageKey,
    stageWave: nonnegative(common.currentStageWave),
    maxCompletedStageKey: nonnegative(common.maxCompletedStage),
    lastClearedStageKey: nonnegative(common.lastClearedStageKey),
    playSeconds,
    // EAggregateType on game v1.3.2: StageClear=13, StageFail=14, PlayTime=15.
    totalClears: aggregate(13, 0),
    stageCounter: allStageCounters[stageKey] ?? 0,
    stageFails: aggregate(14, stageKey) ?? 0,
    totalFails: aggregate(14, 0) ?? 0,
    allStageCounters,
    monsterKills: Array.isArray(player.aggregateSaveDatas) ? keyedTotals(0) : null,
    storedItemQuantities: storedItemQuantities(player, items),
    gold: nonnegative((player.currenySaveDatas ?? []).find(c => c.Key === 100001)?.Quantity),
    goldEarned: aggregate(2, 0),
    goldSource1: aggregate(2, 1)
  };
}

function readSave(file = defaultSavePath()) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) throw new Error('存档类型或大小不受支持。');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.size !== bytes.length || after.size !== before.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('游戏正在保存，请稍后重试。');
    }
    return summarize(bytes, before.mtime.toISOString());
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { defaultSavePath, readSave, fingerprint };

if (require.main === module) {
  try {
    const { allStageCounters, monsterKills, storedItemQuantities, ...summary } = readSave(process.argv[2]);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error.code === 'ENOENT' ? '未找到游戏存档。' : error.message);
    process.exitCode = 1;
  }
}
