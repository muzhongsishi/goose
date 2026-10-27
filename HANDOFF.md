# webrun 会话完整交接文档（2026-10-25 ~ 10-26）

> 给下一个接手的对话。本文件汇总**本会话从头到尾**（10-25 上午接手 Google Antigravity 半成品 → 10-26 现在）的全部进度、结论、材料与经验。
> 项目根 = `../..`，本目录 = `逆向/webrun/`。
> 更细的原始记录见记忆文件 `~/.claude/projects/.../memory/wechat-miniprogram-reverse.md`（项目总进度，30K）与 `webrun-session-cost.md`（token 降本实测）。

---

## 0. 会话概览

- **时间跨度**：2026-10-25 上午 ~ 10-26 现在（约 30 小时，27 个 commit，从 `2ce3d7d` 到 `c6dd6f3`）。
- **起点**：用户从 Google Antigravity 接手——它已把"最难部分"（微信环境 + mock 服务器 + 进主棋盘）做完，但**存档不可靠（刷新卡 98%）、大量功能未覆盖**。
- **终点**：存档可靠、B1-B5 核心循环全部完成并 E2E 全绿、9 个 bug 修复、手机竖屏适配、订单系统上线。
- **总目标**：逆向微信小游戏《肥鹅美食街》(Cocos Creator 2.x)，在浏览器本地完整跑通，localStorage 存档按设备天然隔离（不做登录系统，1-2 人测试）。
- **铁律（用户反复重申）**：能用原版源码就用源码——自有代码只做「微信环境替身」+「游戏服务器替身」两件事，**绝不重写游戏逻辑/UI/数值**；mock 发奖励必须从原版 Config 表读出真实数值模仿，不自己发明。
- **两条线**：`webrun/`（原版本体本地运行，本会话主战场）+ `src/player/`（自研纯净播放器，TapTap 线，本会话未动）。

---

## 1. 起点：接手 Antigravity 并评估（10-25 上午）

**评估结论**：Antigravity 的说法「最难部分已弄完，后面只是工作量」基本正确，但有两个坑要填：存档持久化不可靠、67 处 RPC 调用点全吃同一个假响应导致商店/邮件/活动等静默失效。

**架构核心洞察（后续一切工作的基石）**：该游戏是**客户端权威架构**——合成/掉落/体力全在本地算，服务器只收 diff（`Nu.send` fire-and-forget 打日志即可）。所以 mock 喂一个 `role` 对象 + 所有 RPC 返回 `code:0` 就等于全能服务器。这就是"千行适配撬动 9.3MB 原版代码"的原理。

**测试环境铁律（踩坑换来的）**：
1. 必须**有头模式**——SwiftShader 软渲染不支持 ASTC、后台窗口 rAF 节流都会卡死 Cocos 主循环（headless 全灭）。
2. GM 直达主棋盘必须先 `__gmSkipComic()` 再 `__gmGoToMainBoard()`，否则卡 Intro 引导。
3. Python playwright 与本机 Python 3.14 不兼容，用 puppeteer-core + 系统 Chrome。
4. 页面 localStorage 被 weapp-adapter 替换后 getItem 返回解析好的对象不是字符串；读存档用 `window.__nativeLocalStorage`。
5. 就绪判据用 `role.boards.get(1).cells`，渲染层 `mergeBoardData.cells` 异步填充时序不稳。

---

## 2. 存档持久化战役（10-25 全天，最艰难，4 个叠加病灶）

用户症状链：玩完新手任务 → 刷新卡登录 98% → 或进了棋盘但合成/移动刷新后全丢。**不是单一 bug，是四个叠加病灶**，逐一源码实证后根治：

| # | 病灶 | 根因 | 修法 | commit |
|---|---|---|---|---|
| ① | 引导进度不落档 → 刷新被判"没做教程"重播 Intro 挂死 | guide 是服务器权威：`saveStep` 只在 keyStep 时发 `game_guidesave`，mock 吞掉 → guide 空 Map | 拦截 guidesave 写回 `currentRole.guide` + 空档兜底注入 `Intro=1211/Merge=0` | 9f90ed5 |
| ② | createAt 断链 → `getDay()` TypeError 断启动链 | `deepRevive` 用 `if(v.__d)` 判 Date 标记，`{__d:0}` 的 0 falsy 漏判 → 变普通对象进 `role.createAt` | `__d !== undefined` + restore 末尾强制 coerce | 8fb62bb |
| ③ | 资源下载 fetch body 永久挂起 → 预加载计数不满卡 98% | 浏览器 fetch 层问题（38 请求全 200 但 25 个 res.text() 永不 resolve，node undici 同批 19/19 全过） | 改原生 XHR + 8s 超时 + 3 次重试 | 854f340 |
| ④ | 合成/移动/卖出刷新后全丢 | 进棋盘时客户端把 role 的 board 深拷贝为运行时副本，操作全写副本上；正版靠服务器 `applyFullBoardFromResponse` 写回 role，假服务器不带数据 → role 永不更新 | `saveNow` 前探测运行时副本并把 role 各 board.cells 替换为副本 cells（共享引用） | 119b626 |

**存档触发三层**：操作 RPC 后 0.6s 防抖、10s 兜底 interval、刷新/切页瞬间 `beforeunload` 强制存（纯本地操作靠后两层）。

**关键教训**：自动化环境恰好多一次 RPC 在 PV.init 前修好了 createAt，每次都侥幸逃过——**时序竞态掩盖 bug**，"我全绿用户全卡"。

**存档保护两守卫**（防登录窗口竞态）：有存档且未恢复（`restoreDone`）前不播种、`saveNow` 拒绝落盘。

---

## 3. 告警洪水治理（10-25 晚，commit e34f206）

用户报"每次刷新控制台几千条黄色感叹号"。审计（test-warn-audit.mjs，console API + CDP Log 双通道）实锤：7772 条 warning/次刷新**几乎全是调试遗留**——game.js 的 `>>>` 资源日志注入 ≈5700 条 + wx-polyfill 逐资源追踪 ≈2000 条；原版游戏只有 48 条开机横幅。真 error 仅 favicon 404×2。

**修法**：index.html（在 loader/game.js 之前执行）装 `console.warn` 过滤器拦 `>>>` 前缀（game.js 零改动，不动 Antigravity 的文件）+ wx-polyfill 9 处追踪改 `tr()` 静音，统一 URL `?debug` 恢复全部日志。

**教训**：调试日志用 `console.warn` = 把别人 DevTools 染黄吓人；给用户的健康判据 = 能玩 + 存档在 + 无红色 error。

---

## 4. 订单系统上线（10-25 深夜，commit 4184411）

- 订单列表渲染源 = `board.orders`（键 `"main:"+orderId`），**orders/ordered/orderDrawerEndId 客户端零写入**。
- `completeOrder` RPC 的 orderId 字段 = 订单**实例 id**，记账须翻译成配置 orderId。
- 金币客户端本地发（`role.coin+=` 从 Element.orderCoin 算），存档自动带上。
- 抽屉号 = `floor(orderId/1000)`，整抽屉完成 → `orderDrawerNeedReward`。
- 订单完成回调用不上响应数据（奖励/特效全本地演），只需 code:0。
- 实现：`ensureOrdersSeeded`（幂等播种，原版 orders.json 3432 单经 serve `/config/orders.json` 下发）+ `applyCompleteOrder` + game_completeorder 拦截 sendAsync/send 双路。
- 剩余：做饭链（cookStart）、抽屉奖励、989 个元素奖励订单、教程期交过的单一次性复活。

---

## 5. 模块作战地图（10-25 深夜，commit 5528948）

生成 `逆向/学习资料/07-模块作战地图.md`：全游戏功能盘点 + 作战顺序（A 模式：未覆盖 cmd 逐个补）。**B 核心循环、C 深度玩法（商店/邮件/图鉴/任务成就/鹅装饰/能量/背包/排行榜/软引导）、D 活动大军（digTreasure/masterMatch 优先）、E 商业化/社交/街机永不动**。

---

## 6. B1-B5 核心循环（10-25 深夜 ~ 10-26 上午，commits 3db2e84/010ea99/9cb721f）

### B1 修缮建造
- `game_build`：扣币 = 原版 config 价；`builded.set` 是 isBuilt 唯一判据；`adorns Map`；`areas.push`；`goose.gooses.set`。
- **陷阱**：Build 奖励键拼写 = `Adorn`，装饰定义表名 = `Adron`，两词根都收。
- **HandleRewards = 纯格式化展示，货币类客户端不入账 → mock 服务器记账**；rewards 响应数组元素 = `{itemType,itemId,value}`。
- 进度礼盒 `rewards2` = BuildReward[sheet].count 分段。

### B2 跨天
- `currentTimestamp` 响应**必须带 `{ts,dayEnd}`**（syncRole 无条件 `dayEndTime=getData().dayEnd`，缺字段写成 undefined）。
- 客户端时钟是登录时挂的一次性闹钟（E.addClock），改 dayEndTime 不会提前触发——`__gmNextDay` 直调客户端原生 `onDay00Refresh()`。

### B3 做饭链（cookV2）
- **确认者模式**：客户端乐观演算驱动完整订单状态机（prepare→prepared→running→complete），服务器唯一硬校验 = 响应 cells 数组带 `cell.order`（须 orderId==菜谱id 且 state>=running，否则"authoritative-mismatch"整板远端重建）。
- 菜谱池 = elementMultiOrderPool 732 条（cookware=elementOrderId 负数，ingredients=needElements）。
- V1 系 RPC 不实现（cookV2:true 恒走 V2）。

### B4 抽屉礼盒
- 整抽屉过关 → `orderDrawerNeedReward.set`；领取发 OrderSeries[drawerId].reward 并清标记。
- OrderSeries 是抽屉↔建造联动表。

### B5 手机竖屏框架
- CSS 恒 390:844 最大内接矩形居中。
- **weapp-adapter 的 canvas 工厂给主 canvas 挂假 getBoundingClientRect（恒返回整个视口），Cocos 设计分辨率适配与触摸换算都吃它** → wx-polyfill 用 defineProperty 代理（get 返回真实内接矩形，set 静默吞掉）根治。

---

## 7. 竖屏挤扁 + 重置存档 + 点击错位（10-26 上午，commits 26a0e82/32e021f/576bd48）

- **竖屏挤扁**：游戏认知的屏幕仍是横屏 → 覆盖 `innerWidth/innerHeight`。
- **点击错位根治**：画布贴左上角 + rect 假值防自污染。
- **重置存档清不干净**：旧档还魂跳过教程 → 三步真重置（`__gmResetProgress` 双清 localStorage + 拦截 beforeunload 强存 + 拦截恢复前落盘）。

---

## 8. 修缮建造排障（10-26 上午，commits fc1a2f5/213ae91/5819fc2）

- 用户报修缮按钮点不动/无按钮、点击报"网络环境差"。
- **根因**：`wsDelegate.connected/connectionState` 是**只读 getter**，mock 赋值被静默吞掉 → 客户端认为没联网 → 点建造报"网络环境差"。
- 配套：GM 工具条加测试补给按钮（体力回满+钻石+1000+金币+500）、`__diagBuildBubble` 一键诊断。

---

## 9. 双 bug + 抽屉礼盒 + 三 bug（10-26 下午）

### 双 bug（4bdddf7，用户实机已确认）
- **Bug1 抽屉礼盒不发冰箱组件**：奖励分两半——ShowReward/BoxWindow 纯演出零写入；真服把 element(itemType=7) 写进**响应 role.boards[main].channel（棋盘通道）**。修 = `grantChannelElements` 按 fa 形状累加进活体 board.channel Map，六路（drawer/area/areaLock/levelup/build/buildProgress）全接。
- **Bug2 感叹号点不动+主界面卡死**：真根因不在按钮——ElementDetailWindow 合成链渲染裸取 `role.shop.get(2).goods`，role.shop 空 → TypeError → 窗口 ERROR 静默返回 → **modalBlocker 残留挡全屏触摸**。修 = `ensureRoleShop` 按原版 Shop 表 columnId 分组生成货架。

### 抽屉礼盒每步误发（fc570ea）
- 用户报"完成一小步就发礼盒、第二小步发两盒"。根因 = mock 每完成一个订单就 set needReward，客户端以 has(drawerId) 为唯一闸门**自动**领礼盒。修 = 只在 configOrdersInDrawer 全部 ordered（整抽屉完成）时 set。

### 三 bug（a46b57a，E2E 通过但未用户实机确认）
见 `2.1`-`2.5` 节（RPC 命名 / 奖励词法 / channel / 肥鹅 / 图鉴）。三个都是「RPC 未实现走兜底」导致：
- 肥鹅领钻后显示"牙牙"、重开又让解锁 → `game_goosereward` 发 `Goose[id].unlockReward` + `gooses[id].rewarded=true`。
- 图鉴大礼包点击无效果 → `game_elementhandbookreward`/`game_getelementhandbook` 补实现。
- 切主菜单↔棋盘自动重复发奖励 → channel 不落盘 + 全量下发前 `stripTransientChannel`。

---

## 10. token 归因 + 模块索引（10-26 下午，commit b18e7d6）

用户问"查代码 token 消耗大，是不是单文件没分块"。结论：`main-pretty.js`（19.6 万行）是**官方构建产物 js-beautify 格式化副本，不是逆向重写**；有 914 个 `cc._RF.push(module,"uuid","原始文件名")` 模块边界（miniGame-pretty.js 219 个，共 1133 个脚本原名存活）。单文件只让定位成本多约 20-30%，大头是**理解成本**。已生成 `逆向/学习资料/code/模块索引.md`（模块名→行号映射）。

实测 token 分布（webrun-session-cost.md）：读游戏源码考古占 67%、写脚本/改代码 14%、E2E 输出仅 1%；**墙钟大头 ≠ token 大头**（E2E 42 次浏览器开机每次 60-90s 是用户感觉"很久"的直接原因）。

---

## 11. 本会话完整 commit 时间线（27 条）

```
c6dd6f3 10-26 15:18 docs: 会话交接文档
a46b57a 10-26 14:51 fix: 三bug——肥鹅领钻/图鉴礼盒/channel重复发
fc570ea 10-26 14:02 fix: 抽屉礼盒每步误发
b18e7d6 10-26 13:52 docs: 模块索引(914+219)
c021680 10-26 13:45 docs: 作战地图进度日志
4bdddf7 10-26 13:32 fix: 双bug(channel奖励+货架兜底)
5819fc2 10-26 11:29 fix: 修缮"网络环境差"(wsDelegate只读getter)
213ae91 10-26 09:24 feat: 修缮排障配套
fc1a2f5 10-26 09:16 feat: GM补给按钮
576bd48 10-26 08:12 fix: 竖屏点击错位根治
32e021f 10-26 07:59 fix: 重置存档清不干净
26a0e82 10-26 07:50 fix: 手机框架挤扁根因
9cb721f 10-26 07:41 feat: B5竖屏框架
010ea99 10-25 23:58 feat: B3做饭链cookV2
3db2e84 10-25 23:47 feat: B1修缮+B2跨天+B4抽屉+升级
5528948 10-25 23:17 docs: 07-模块作战地图
4184411 10-25 22:53 feat: 订单系统上线
e34f206 10-25 22:10 fix: 告警洪水治理(7772→48)
6612677 10-25 19:18 chore: 归档诊断脚本
119b626 10-25 19:11 fix: 运行时棋盘回填(合成/移动刷新丢失)
8fb62bb 10-25 18:04 fix: 根治getDay断链卡98%
854f340 10-25 17:46 fix: 资源下载fetch→XHR+超时重试
1c187d3 10-25 17:29 fix: serve禁用缓存+旧坏档救援
9f90ed5 10-25 14:12 fix: 引导进度不落档挂死98%
bccd12d 10-25 13:45 fix: 存档卡98%与存档被冲两根因
7345997 10-25 12:42 feat: role本地存档持久化
2ce3d7d 10-25 12:16 feat: 固化webrun成果+官方播放器骨架
```

（10-22 及更早的 commit 是 src/player 自研线 + 逆向资源，非本会话。）

---

## 12. 关键技术结论（后续开发直接可用）

### 12.1 RPC 命名规则
客户端 `Od.xxx` 方法 → cmd = `game_` + 方法名**全小写**。例：`gooseReward`→`game_goosereward`、`elementHandBookReward`→`game_elementhandbookreward`、`getElementHandBook`→`game_getelementhandbook`、`orderDrawerReward`→`game_orderdrawerreward`。

### 12.2 奖励 key 词法（`parseRewardMap`，mock-network.js L450）
纯数字=element(7)、`Adorn`/`Adron<id>`=装饰(8)、`goose<id>`=肥鹅(14)、`Area<id>`=区域(13)、`Coin`=1、`Diamond`=2、`Exp`=3、`Energy`=4、`SpeedUpCoupon`=5。`grantCurrency` 只入账 1-5；element(7) 走 `grantChannelElements` 落 channel。

### 12.3 channel（棋盘通道）机制
瞬态奖励载体：真服把"待飞入 element"写进 `role.boards[main].channel`（`Map<itemId, fa{id,itemType,itemId,value,state,from,bagId}>`）。客户端 `sendElementsToBoard`（main-pretty.js L76484）只认 channel 消费飞入 cells，`removeBoardElementChannelItem`（L76705）**同时清 o3.Data.channel 和 d3.role.boards.channel**；但客户端消费的是自己副本、不回写 mock 活体 → 残留。根治 = 不落盘（saveNow 序列化前摘除/后还原）+ 全量下发前 `stripTransientChannel`。

### 12.4 肥鹅领奖
`GooseHandbookItem.onClickClaim`（L159695）→ `Od.gooseReward`。奖励=`Goose[id].unlockReward`（如 `{"Diamond":10}`）。防重领靠 `gooses[id].rewarded`（客户端 hasUnclaimed 遍历 gooses 看 rewarded）。**Goose 表平铺** `{1001:{id,unlockReward,...}}`（23 条）。

### 12.5 图鉴领奖
`ElementCollectionItem.onClickGift`（L141611）→ `Od.elementHandBookReward`。奖励=`Element[id].unlockReward`（如 `{"SpeedUpCoupon":3}`）。状态类 gh 数据源=`getElementHandBook`→`{handbook:Map<elementId,0|1>}`（0未领/1已领），`gh.Initialize`（L11244）整体覆盖本地。**element 表 sheet 结构** `{Vegetable:{1001101:{id,unlockReward,...}},...}`（15 sheet），`COOK_INDEX.elem[id]` 已拍平。

### 12.6 存档序列化（`saveNow` L146 / `deepSerialize` L42 / `deepRevive` L74）
Map→`{__m:[[k,v]...]}`、Set→`{__s:[...]}`、Date→`{__d:ms}`。**Date 判据用 `__d !== undefined`（不能用 `if(v.__d)`，0 值漏判）**。存档 key=`fe_saved_role_v1`，读用 `window.__nativeLocalStorage`。

### 12.7 兜底响应
`Nu.sendAsync`（L1250）按 gcmd 分支；未实现 cmd 走兜底（L1380 附近）全量下发 role（含 `game_enterboard`/`game_syncdata`/`game_rolelogin`）。`game_rolelogin` 分支先 `restoreSavedRole` 还魂存档。兜底响应前已加 `stripTransientChannel`。

---

## 13. 材料清单

| 文件（相对项目根） | 用途 |
|---|---|
| `逆向/webrun/mock-network.js` | **核心**：mock 服务器（拦截 HTTP/WS RPC，扮演微信环境+游戏服务器），本会话从 ~10KB 长到 ~1500 行 |
| `逆向/webrun/serve.mjs` | 资源服务器（8123+3002 双端口），`/config/table/<Name>.json` 从 gameConfig.json 抽表（**键大小写敏感**） |
| `逆向/webrun/wx-polyfill.js` | 微信环境替身（含 canvas getBoundingClientRect 代理、fetch→XHR） |
| `逆向/webrun/index.html` | 宿主 + GM 调试工具条 |
| `逆向/webrun/verify-3bugs.mjs` | 三 bug 回归验证脚本 |
| `逆向/学习资料/code/模块索引.md` | 914+219 模块名→行号映射（窄读定位） |
| `逆向/学习资料/code/main-pretty.js` / `miniGame-pretty.js` | 官方产物（只读，19.6万+6万行） |
| `逆向/学习资料/data/gameConfig.json` | 236 张配置表解码（Goose/element/Build/Shop/OrderSeries…） |
| `逆向/学习资料/07-模块作战地图.md` | 全功能盘点+作战顺序+进度日志 |
| `逆向/学习资料/01-06/README` | 合成链/棋盘/鹅/机制/代码地图/特效 |

**GM 钩子**（page.evaluate 里可调）：`window._user_mgr_.role`、`window.net.sendAsync({cmd,params})`、`__mockSaveNow()`、`__readRawSave()`、`__gmGoToMainBoard()`、`__gmSkipComic()`、`__gmNextDay()`、`__gmResetProgress()`、`__mockBuild(id)`、`__orderState()`、`__mockCompleteOrder(id)`、`__cookState(index)`、`__mockCookPut/Start` 等（详见 mock-network.js L1428 起）。

**测试 profile**：`/tmp/lj-drawer-v`（旧档）、`/tmp/lj-3bugs-v`（三 bug 新档）。puppeteer-core + 系统 Chrome 有头。

---

## 14. 经验教训（本会话沉淀）

1. **读代码纪律（用户重点批评）**：先查 `模块索引.md` 拿行号 → `sed` 窄读 30-60 行，**不整段 dump、不回头重读已确认的代码**。根因已定就停手。
2. **E2E 一次开机覆盖多个 bug**，少写一次性 diag 脚本（本会话曾写 19 个 diag，收敛到 1 个 verify）。
3. **断言陷阱**：验证"某字段不落盘"用全文搜真实 id 会误报（冰箱 1002101 本就在初始 cells）——**塞假 id（999999）到该字段再查存档**；用 delta 断言（`diamond===pre+10`）而非绝对值（复用 profile 不误判）。
4. **持久 userDataDir 才能复现"回归玩家"场景**，自动化全新 profile 覆盖不到用户真实路径。
5. **数据层 ≠ 渲染层**：`window.role`/`_user_mgr_.role` 是数据锚点，`_board_renderer_`/`mergeBoardData` 是渲染层，断言要用对。
6. **"没反应/卡死" = 静默失败**：先看控制台红色 error（常是客户端取响应字段抛 TypeError 被 catch 吞掉），根因在响应结构缺失不在按钮。
7. **时序竞态掩盖 bug**：自动化环境恰好多一次 RPC 修好状态 → 我全绿用户全卡。给用户判据 = 能玩+存档在+无红色 error，不能只看自动化。
8. **重跑回归前必须 rm profile**（旧档带记录 → 新档断言全挂，幂等拒重复≠回归失败）。
9. **调试日志用 console.warn = 染黄别人 DevTools**；debug 日志走 tr() 静音，统一 `?debug` 开关。

---

## 15. 待办 / 下一步

- [ ] **用户实机确认最后三 bug**（肥鹅领钻/图鉴礼盒/channel 重复发，a46b57a 已 E2E 过但未实机）。
- [ ] **清理 23 个 `diag-*.mjs` 一次性诊断脚本**（`逆向/webrun/` 下，未跟踪，待用户决定删 or 留）。
- [ ] **C 深度玩法**（按游玩遭遇顺序，每个都是「A 模式：未覆盖 cmd → game_xxx 全小写 → mock 加分支 + 从原版 Config 表读真实数值」）：
  - 商店（Shop 表已抽，`ensureRoleShop` 已有货架数据，缺买卖流程）
  - 邮件 / 任务成就 / 排行榜 / 软引导
  - 鹅图鉴（本次只做了元素图鉴领奖 + 肥鹅领钻，鹅的合成/装饰/展示未覆盖）
  - 能量 / 背包
- [ ] **主线实机只验证到第 1 天**，配置已到抽屉 496（day 0–495），往前玩撞到未覆盖 cmd 即报即修。
- [ ] 交接记忆：`wechat-miniprogram-reverse.md` 已含全部进度，`webrun-session-cost.md` 含降本铁律，接手先读这两个 + 本文件。
