# 《肥鹅美食街》本地化 RPC 与功能模块全景推进清单 (API ROADMAP)

> 本清单基于前端源码 (`main-pretty.js` L8390~8578) 全量网络通信服务与 RPC 映射表提取，按游戏主线自然依赖推进。

---

## 阶段一：主循环与核心交互（已闭环 ✅）
- [x] **登录与初始化**
  - `Login.authUser` / `game_rolelogin`: 账号认证与角色初建/恢复
  - `game_currenttimestamp`: 时间戳与跨天日界校准
  - `game_guidesave`: 引导步骤实时持久化
  - `game_dayrefresh`: 自然日界跨天刷新
- [x] **棋盘合成核心**
  - `game_cellmove` / `multipleCellMove`: 道具拖拽与合成
  - `game_cellproduct` / `multipleCellProduct`: 菜篮子/发射器点击产出
  - `game_cellsell`: 道具出售折现
  - `game_cellopen`: 宝箱/气泡开启
  - `game_cellcollect` / `multipleCellCollect`: 体力/经验/金币道具吸收
  - `game_cellbuycd`: 棋盘生成器加速、做菜花钻加速
  - `game_breakbubble`: 气泡破裂
  - `game_cellundo`: 误操作回退
- [x] **做菜烹饪系统 (cookV2)**
  - `game_cookstart`: 炊具投料点火
  - `game_cookputingredients`: 食材放入
  - `game_cooktakeingredient`: 食材取出
  - `game_cookcancel`: 废弃倒掉/停止烹饪
  - `game_cookcollect` / `game_cookcollectbatch`: 成品出锅收菜
- [x] **主线订单与抽屉任务**
  - `game_completeorder`: 提交订单
  - `game_orderdrawerreward`: 抽屉阶段礼盒开箱并发往左上角气泡通道
  - `game_enternewdrawer`: 开启下一轮抽屉任务
- [x] **餐厅修缮与装扮**
  - `game_build`: 消耗金币修缮装修
  - `game_arearewardget`: 区域完工大礼包
  - `game_adornedit`: 更换家具装扮
  - `game_adornskinbuy`: 购买皮肤
  - `game_adornskinreward`: 领取皮肤进度奖励
  - `game_claimboardareareward`: 棋盘区域解锁奖励
- [x] **基础商店**
  - `game_shopbuy`: 购买商店道具
  - `game_shoprefresh`: 免费/花钻刷新货架
  - `game_shopcheck`: 货架状态校准

---

## 阶段二：仓储与收纳体系（已闭环 ✅）
- [x] **常规背包 (Game Bag)**
  - `game_bagbuy`: 扩充背包格子（读 `Bag` 配置表扣钻/金币增加 `size`）
  - `game_celltobag`: 棋盘道具移入背包（校验格子上限，从 `cells` 移除，写入 `bag.items`）
  - `game_cellbagput`: 背包道具放回棋盘（从 `bag.items` 移除，写回 `cells`）
  - `game_channelbag`: 左上角暂存道具放入背包
- [x] **发射器专用仓库 (LauncherBag)**
  - `launcherbag_show`: 查询发射器仓库状态
  - `launcherbag_put`: 棋盘发射器存入发射器仓库
  - `launcherbag_takeout`: 发射器取出到棋盘
  - `launcherbag_recycle`: 回收废弃发射器换取资源

---

## 阶段三：任务、成就与图鉴体系（已闭环 ✅）
- [x] **图鉴系统 (HandBook)**
  - `game_getelementhandbook`: 获取全图鉴解锁列表（支持派生计算与状态持久化）
  - `game_elementhandbookreward`: 首次合成新道具图鉴钻石奖励（防重复领奖并存盘）
- [x] **鹅仔互动 (Goose)**
  - `game_goosereward`: 肥鹅解锁/升级互动奖励（与建筑修缮解锁定向打通）
- [x] **日常与周常任务 (WeekTask)**
  - `weektask_syncprogress`: 任务进度同步与刷新（打通合成、做菜、交订单实时埋点）
  - `weektask_synccyclelogin`: 累计登录天数统计与同步
  - `weektask_claimtaskreward`: 领取单项日常/周常小任务奖励及周活跃积分
  - `weektask_claimprogressreward`: 累积活跃积分领取周阶段大宝箱
  - `weektask_weekfresh`: 自然周跨周重置与刷新
  - `weektask_claimlastweekreward`: 跨周补领上周未领宝箱
- [x] **相册与店长形象系统 (ImgBox)**
  - `imgbox_show`: 头像、相框、店长装扮、宠物、成就徽章数据展示
  - `imgbox_edit`: 更换头像、相框、服装、宠物及改名
  - `imgbox_unlock`: 解锁/购买装扮与相框
  - `imgbox_wearbadge`: 佩戴成就徽章
  - `imgbox_editpetname`: 修改宠物昵称

---

## 阶段四：系统信箱与福利体系（已闭环 ✅）
- [x] **邮件系统 (Mail)**
  - `game_getmails`: 拉取系统邮件列表（官方通知、补偿邮件）
  - `game_readmail`: 邮件标记已读并消除红点
  - `game_attachmentmail`: 领取邮件附件道具进气泡通道与角色属性
  - `window.sendMail`: 支持工作站 GM / 本地自由实时发邮件发奖
- [x] **签到与福利 (Sign & Welfare)**
  - `game_minicentersign`: 微中心授权与平台接入支持
  - `newplayergift_reward`: 新手成长狂欢礼包
  - `wechatsubscription_claimreward` / `subscribe`: 关注订阅与状态同步奖励

---

## 阶段五：通行证系统与排行榜竞赛（已闭环 ✅）
- [x] **赛季通行证 (BattlePass / Pass)**
  - `pass_reward`: 通行证经验升级与领奖，支持免费轨（Free）、进阶轨（VIP）、荣耀循环轨（SVIP）
  - 支持单档领取与一键全领（`claimAll`），奖励自动结算进棋盘通道与货币
  - 任务、订单、做菜、棋盘合成实时联动增加通行证点数（`passPoint`）
  - 挂载 GM 指令：`window.openPassWindow()`、`window.addPassPoints(n)`、`window.unlockPassVIP(level)`
- [x] **能量挑战通行证 (EnergyPass)**
  - `energypass_passnewreward`: 阶梯消耗体力目标达成领奖
  - `energypass_claimallreward`: 一键全领全部已达标阶段的高额体力与道具大礼包
  - 棋盘消耗体力实时同步点数增长
  - 挂载 GM 指令：`window.openEnergyPassWindow()`、`window.addEnergyPassPoints(n)`
- [x] **排行榜与单机竞技 (Ranks & Races)**
  - `rank_current` / `rank_actget`: 查询当前名次与好友/虚拟对手榜单
  - `weightrace_start` / `weightrace_claimendreward`: 体重争霸赛开赛与结算大奖
  - `gymsprint_claim`: 运动冲刺里程碑奖励结算
  - 挂载 GM 指令：`window.openWeightRaceWindow()`、`window.openGymSprintWindow()`
  - `gymsprint_claim` / `weightrace_*` / `upgraderace_*`: 周期性爬榜小赛事
