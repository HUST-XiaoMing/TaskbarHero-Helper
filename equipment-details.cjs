'use strict';

const modifiers = {FLAT:'固定', ADDITIVE:'加算', MULTIPLICATIVE:'乘算'};
// GameAssembly v1.3.2, stat conversion functions at RVAs E4AE20 / E4AE40.
const flatUnits = new Set([0,1,5,6,9,12,13,14,15,20,22,29,30,31,32,33,48,52,58,59,64,70,72,74,77,80]);
const flatHundredths = new Set([2,7,11,23,49]);

function formatStat(stat, mod, value, data, statIds) {
  const label = data?.statLabels?.[stat] || stat || '未知属性';
  if (!Number.isFinite(value)) return label + '（数值未知）';
  const template = data?.statTemplates?.[stat + '_' + mod];
  const id = statIds.get(stat);
  if (data?.gameVersion !== '1.3.2' || !template || !template.includes('{0}') ||
      !Number.isInteger(id) || id < 1 || id > 81 || !modifiers[mod]) {
    return label + '（' + (modifiers[mod] ? modifiers[mod] + '，' : '') + '配置原值 ' + value + '）';
  }
  let amount = value;
  if (mod !== 'FLAT') {
    amount = value / 10; // Non-flat multipliers are per mille, displayed as percent.
  } else if (flatHundredths.has(id)) {
    amount = value / 100;
  } else if (id === 40) {
    amount = value / 10;
  } else if (!flatUnits.has(id)) {
    amount = value / (template.includes('%') ? 10 : 1000);
  }
  if (stat === 'IncreaseExpAmount') return '经验获得 ' + (amount >= 0 ? '+' : '') + amount + '%';
  // The string table supplies the sign, unit and wording for each stat + mod pair.
  return template.replace('{0}', String(amount)).replace(/\+-/g, '−');
}

function uniqueEffect(key, data) {
  const effect = data?.uniqueMods?.[key];
  if (!effect?.description) return effect?.name || ('效果 #' + key);
  let unresolved = false;
  const text = effect.description.replace(/\{(\d+)\}/g, (_, index) => {
    const param = effect.params?.find(p => p.index === Number(index) + 1);
    const skill = data.skills?.[param?.value];
    if (skill && !param.max) return skill.name;
    unresolved = true;
    return 'X';
  });
  return text + (unresolved ? '（X 为待核词条参数）' : '');
}

function instanceAffix(affix, data, statIds) {
  const definition = data?.affixes?.[affix.statModKey];
  const savedStat = data?.statIds?.[affix.statType];
  const savedMod = data?.modIds?.[affix.modType];
  const stat = savedStat || (affix.statType == null ? definition?.stat : '属性 #' + affix.statType);
  const mod = savedMod || (affix.modType == null ? definition?.mod : null);
  const conflict = definition && ((affix.statType != null && savedStat !== definition.stat) ||
    (affix.modType != null && savedMod !== definition.mod));
  const fallback = definition && (affix.statType == null || affix.modType == null);
  let text = formatStat(stat, mod, affix.value, data, statIds);
  if (affix.tier > 0) text += ' · T' + affix.tier;
  if (conflict) text += '（按存档，模板为' + (data.statLabels?.[definition.stat] || definition.stat) +
    '·' + (modifiers[definition.mod] || definition.mod) + '）';
  else if (fallback) text += '（缺失的类型按模板）';
  return text;
}

function equippedRows(hero, data) {
  const statIds = new Map(Object.entries(data?.statIds || {}).map(([id,stat]) => [stat,Number(id)]));
  return (hero?.equipment || []).filter(e => e.itemKey || e.missing).map(e => {
    const item = data?.items?.[e.itemKey];
    const slot = item && (data.parts?.[item.part] || item.part) || '槽位 ' + (e.slot + 1);
    if (e.missing) return {slot,name:'存档缺少该件装备记录',stats:'—',affixes:'—'};
    const stats = (item?.stats || []).map(a => formatStat(a.stat,a.mod,a.value,data,statIds));
    if (e.chaotic && item) stats.unshift('普通模板参考，混沌变动待核');
    for (const key of item?.uniqueMods || []) {
      stats.push('独特效果 · ' + uniqueEffect(key,data));
    }
    const affixes = (e.affixes || []).map(a => instanceAffix(a,data,statIds));
    return {slot, name:(e.chaotic ? '混沌 · ' : '') + (item?.name || '装备 #' + e.itemKey),
      stats:stats.join('\n') || (item ? '—' : '缺少该版本的模板'), affixes:affixes.join('\n') || '—'};
  });
}

module.exports = { equippedRows };
