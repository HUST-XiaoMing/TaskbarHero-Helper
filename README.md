# TaskbarHero 刷图助手

《TBH：塔斯克巴·英雄》的非官方 Windows 桌面工具。选一名出战英雄，就能比较已通关关卡的每小时经验和金币收益。想解锁宠物时，也可以按目标怪物的击杀效率选图。

## 下载与启动

1. 下载最新的 [Windows 64 位玩家版 ZIP（约 46 MB）](https://github.com/HUST-XiaoMing/TaskbarHero-Helper/releases/latest/download/TaskbarHero-Helper-Windows-x64.zip)。也可以在[版本发布页](https://github.com/HUST-XiaoMing/TaskbarHero-Helper/releases/latest)查看更新说明。
2. 将整个 ZIP 解压到桌面等可以写入的文件夹，双击 `TBH刷图助手.exe`。适用于 Windows 10/11 x64，使用系统的 .NET Framework 4.x，玩家版已附带 Node.js 和 Python。
3. 助手会自动查找 Steam 游戏库。如果找不到，先在 Steam 游戏库中右键游戏，选择 **管理 → 浏览本地文件**，再在助手的 **游戏目录 → 选择游戏目录** 中选中打开的文件夹。里面应有 `TaskBarHero.exe` 和 `TaskBarHero_Data`。

## 怎么选图

- **刷经验或金币**　选择英雄和目标后，先在同一配置下试刷。同一关累计至少 3 次通关、2 分钟的有效记录后，就会参与实测推荐。
- **刷宠物**　切换到“宠物刷图”，选中目标宠物，可以查看对应怪物在哪些关卡出现，以及每轮预计遇到几只。
- **查看装备**　点“查看装备”可核对当前英雄穿戴的物品、实际词条和出战技能。

## 存档和版本

助手以只读方式读取当前 Windows 用户的游戏存档，个人刷图记录保存在助手目录的 `state/history.json`。如果提示缺少存档，请先进入游戏并等待一次自动保存。规划和装备查询可以离线使用，双击已收录的关卡会打开中文 Wiki 攻略页。

已验证的游戏版本为 **1.3.2**。实时波次、击杀和战斗金币只在匹配已验证的游戏程序时显示。其他版本的兼容性取决于资源和存档格式，游戏表暂时无法解析时仍可查看已有的存档实测收益。[完整使用说明](./使用说明.txt)

## 资料来源与声明

关卡、怪物、英雄、装备和宠物资料来自玩家自己的游戏安装文件。常规关卡的基础收益估算参考了 TBH Wiki 的刷取计算规则。例如，怪物表缺少某个怪物时，估算会保留它的出现权重，并将它贡献的收益计为零。1.3.2 以外版本的经验等级系数也参考了 Wiki 公式。1.3.2 的 108 个常规关卡已用 Wiki 关卡表核对过基础经验和金币估算。[TBH Wiki 刷取计算器](https://tbhwiki.org/zh/farm) · [关卡资料](https://tbhwiki.org/zh/stages)

本助手是非官方玩家工具。游戏及 Wiki 内容的相关权利归各自权利人所有。收益预测仅供选图参考，实际结果会随配装、通关耗时和游戏版本变化。[游戏使用条款](https://store.steampowered.com/eula/3678970_eula_1) · [TBH Wiki 使用条款](https://tbhwiki.org/terms-of-service)

如果你是相关内容的权利人，认为本项目的内容可能侵犯你的权益，或发现署名有误，欢迎通过 GitHub Issues 联系我。请指出涉及的文件或页面，并附上原始来源，方便我核实后更正署名、调整或移除相关内容。[联系项目维护者](https://github.com/HUST-XiaoMing/TaskbarHero-Helper/issues/new)
