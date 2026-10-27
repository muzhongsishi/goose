// 肥鹅美食街 - 本地 Mock 网络层
// 拦截 Orange 框架的 HTTP / WebSocket RPC 调用，使其在纯单机 Web 浏览器环境中无缝运行
(function(window) {
  console.log('[mock-network] 模块初始化...');

  if (!Map.prototype.toJSON) {
    Map.prototype.toJSON = function() {
      var o = {};
      this.forEach(function(v, k) {
        o[k] = v;
      });
      return o;
    };
  }

  try {
    localStorage.setItem('userAgree', 'true');
    localStorage.setItem('userAgree', JSON.stringify('true'));
  } catch(e) {}

  // getDay 免疫补丁:客户端留存统计对 role.createAt 调 getDay(),而 reset() 重造的 role
  //里 createAt 可能是数字/字符串/标记对象(非 Date)→ 崩溃并打断登录后引导链(卡98%)。
  //给 Number/String 原型补 getDay,非 Date 接收者也能安全返回(真 Date 走原生实现不受影响)。
  try {
    if (!Number.prototype.getDay) Number.prototype.getDay = function () { return new Date(this.valueOf()).getDay(); };
    if (!String.prototype.getDay) String.prototype.getDay = function () { var t = Date.parse(String(this)); return new Date(isNaN(t) ? 0 : t).getDay(); };
  } catch (e) {}

  // 本文件先于 weapp-adapter 执行,此刻 window.localStorage 仍是原生对象;
  // 之后 adapter 会把它替换成自己的模块,存档必须始终走原生引用
  const nativeLocalStorage = window.localStorage;

  let _net = null;
  let _user_mgr = null;

  // ==================== 本地存档持久化 (2026-10-25) ====================
  // 原版存档全在服务器,重载即丢档;这里把 role 深度序列化进 localStorage,
  // 下次启动在 initRole 里原位恢复。Map/Set 用 __m/__s 标记,深度限 12 层防循环引用。
  const SAVE_KEY = 'fe_saved_role_v1';
  const SKIP_KEYS = { node: 1, view: 1, owner: 1, target: 1, delegate: 1, listener: 1, emitter: 1, scene: 1, _isMounted: 1 };

  function deepSerialize(v, depth) {
    if (v === null) return null;
    var t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') return v;
    if (t === 'function' || t === 'undefined') return undefined;
    if (depth > 12) return null;
    if (v instanceof Map) {
      var entries = [];
      v.forEach(function (mv, mk) {
        entries.push([deepSerialize(mk, depth + 1), deepSerialize(mv, depth + 1)]);
      });
      return { __m: entries };
    }
    if (v instanceof Set) {
      var items = [];
      v.forEach(function (sv) { items.push(deepSerialize(sv, depth + 1)); });
      return { __s: items };
    }
    if (v instanceof Date) return { __d: v.getTime() };
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(deepSerialize(v[i], depth + 1));
      return arr;
    }
    var o = {};
    for (var k in v) {
      if (SKIP_KEYS[k]) continue;
      o[k] = deepSerialize(v[k], depth + 1);
    }
    return o;
  }

  function deepRevive(v, depth) {
    if (v === null || typeof v !== 'object' || depth > 12) return v;
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(deepRevive(v[i], depth + 1));
      return arr;
    }
    if (v.__m) return new Map(v.__m.map(function (p) { return [deepRevive(p[0], depth + 1), deepRevive(p[1], depth + 1)]; }));
    if (v.__s) return new Set(v.__s.map(function (x) { return deepRevive(x, depth + 1); }));
    // 注意 __d !== undefined: 用 if(v.__d) 会把 {__d:0}(纪元0)漏成普通对象,
    //该对象覆盖进 role.createAt 后 getNaturalCreateDay().getDay() 当场崩、断登录链(卡98%)
    if (v.__d !== undefined) return new Date(v.__d);
    var o = {};
    for (var k in v) o[k] = deepRevive(v[k], depth + 1);
    return o;
  }

  // 运行时棋盘回填:客户端进棋盘时把 role 的 board 深拷贝成运行时副本
  //(cacheBoards,refreshCachedBoardFromRemote),合成/移动/产出全写在副本上;
  //正版权靠服务器响应(applyFullBoardFromResponse)把新棋盘写回 role,假服务器没有这一步,
  //导致"画面变了但存档永远是旧的"(刷新回初始棋盘)。
  //修复:存档前把 role 的 board.cells 替换为运行时副本的 cells(共享引用),
  //此后运行时每次写棋盘都直接反映进 role,一次覆盖合成/移动/点击产出/卖出全部操作
  function findRuntimeBoards() {
    var found = [], seen = new Set();
    function scan(o, depth) {
      if (!o || depth > 3 || seen.has(o) || found.length >= 4) return;
      seen.add(o);
      try {
        if (o.cells instanceof Map && o.cells.size >= 40) {
          var vals = [];
          o.cells.forEach(function (v) { vals.push(v); });
          var withElem = vals.filter(function (v) { return v && v.elementId !== undefined; }).length;
          if (withElem >= vals.length * 0.5) { found.push(o); return; }
        }
      } catch (e) {}
      if (typeof o !== 'object') return;
      var keys;
      try { keys = Object.keys(o); } catch (e) { return; }
      for (var i = 0; i < keys.length && i < 80; i++) {
        try { scan(o[keys[i]], depth + 1); } catch (e) {}
      }
    }
    var roots = [window._board_renderer_, window._user_mgr_].filter(Boolean);
    for (var ri = 0; ri < roots.length; ri++) scan(roots[ri], 0);
    return found;
  }
  function syncRuntimeBoardsToRole(role) {
    try {
      if (!role || !(role.boards instanceof Map)) return false;
      var runtimeBoards = findRuntimeBoards();
      var synced = 0;
      role.boards.forEach(function (rb) {
        if (!rb || !(rb.cells instanceof Map)) return;
        // 按 id 匹配运行时副本,匹配不上且只有一个副本时也回填主棋盘
        var match = runtimeBoards.filter(function (m) { return m.id === rb.id; })[0];
        if (!match && runtimeBoards.length === 1 && rb.cells.size > 0) match = runtimeBoards[0];
        if (match && match.cells && match.cells !== rb.cells && match.cells.size >= rb.cells.size * 0.5) {
          rb.cells = match.cells;   // 共享引用:运行时后续写入直接进 role
          synced++;
        }
        if (match && match.channel instanceof Map && match.channel !== rb.channel) {
          // 共享 channel 引用: 运行时消费/删除奖品直接反映到 role, 防止全量覆盖导致已消费奖品还魂
          rb.channel = match.channel;
        }
        if (match && match.bag && rb.bag) {
          // 共享 bag 引用: 运行时存入/取出直接反映到 role
          if (match.bag.items instanceof Map) rb.bag.items = match.bag.items;
          if (match.bag.size) rb.bag.size = match.bag.size;
        }
      });
      if (synced && !window.__mockBoardSyncedLog) {
        console.log('[mock-save] 运行时棋盘已绑定到 role(存档将反映合成/移动等操作)');
        window.__mockBoardSyncedLog = true;
      }
      return synced > 0;
    } catch (e) { return false; }
  }
  var cloudSyncTimer = null;
  function scheduleCloudSync(role, serializedData) {
    var uid = window.getCurrentPlayerUID ? window.getCurrentPlayerUID() : (localStorage.getItem('fe_player_uid') || '');
    if (!uid) return;
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(function () {
      cloudSyncTimer = null;
      if (window.__updateCloudSyncStatus) window.__updateCloudSyncStatus('syncing');
      var summary = {
        day: (role.day && role.day.naturalDay) || 1,
        level: (role.user && role.user.level) || 1,
        coin: (role.wallet && role.wallet.coin) || 0,
        energy: (role.energy && role.energy.cur) || 0
      };
      fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: uid,
          roleData: serializedData,
          summary: summary
        })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.ok) {
          if (window.__updateCloudSyncStatus) window.__updateCloudSyncStatus('synced');
        } else {
          if (window.__updateCloudSyncStatus) window.__updateCloudSyncStatus('error');
        }
      }).catch(function (e) {
        if (window.__updateCloudSyncStatus) window.__updateCloudSyncStatus('offline');
      });
    }, 1200);
  }

  function mergeCloudMails(role) {
    if (!role || !window.__pendingCloudMails || !window.__pendingCloudMails.length) return;
    if (!Array.isArray(role.mails)) role.mails = [];
    var uid = window.getCurrentPlayerUID ? window.getCurrentPlayerUID() : (localStorage.getItem('fe_player_uid') || '');
    var added = 0;
    window.__pendingCloudMails.forEach(function (m) {
      if (!m || !m.id) return;
      var exists = role.mails.some(function (ex) { return Number(ex.id) === Number(m.id); });
      if (!exists) {
        role.mails.unshift(m);
        added++;
        if (uid) {
          fetch('/api/mail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ack', uid: uid, mailId: m.id })
          }).catch(function () {});
        }
      }
    });
    if (added > 0) {
      role.mailNewCount = (role.mailNewCount || 0) + added;
      try {
        if (window.w && window.g && window.g.Mail_Load) window.w.emit(window.g.Mail_Load);
      } catch (e) {}
      if (window.__updateMailBadge) window.__updateMailBadge(role.mailNewCount);
    }
    window.__pendingCloudMails = [];
  }

  window.__syncRuntimeBoards = function () { return syncRuntimeBoardsToRole(_user_mgr && _user_mgr.role); };
  window.__findRuntimeBoards = findRuntimeBoards; // 调试/测试钩子

  function saveNow() {
    try {
      // 重置存档中(__gmResetProgress 已双清 localStorage):此刻任何落盘——尤其是
      //reload 触发的 beforeunload 强存——都会把内存里的活体 role 写回去,旧档还魂,
      //重置等于没按(实测踩坑)
      if (window.__suppressMockSave) return false;
      var role = _user_mgr && _user_mgr.role;
      if (!role || !role.boards || !role.boards.get || !role.boards.get(1)) return false;
      // 存档保护:盘上已有存档且本页面生命周期还没恢复它时,此刻的 role 是客户端
      //reset 出来的全新空壳,此刻落盘会用空壳覆盖玩家进度(登录窗口竞态)——拒绝
      if (hasSavedRole() && !restoreDone) {
        console.warn('[mock-save] 拦截恢复前的落盘(防覆盖存档)');
        return false;
      }
      syncRuntimeBoardsToRole(role);   // 先回填运行时棋盘,再序列化
      // channel 不持久化(瞬态奖励载体,残留会导致重进棋盘重复飞入):序列化前摘除、
      // 序列化后还原活体,既不落盘也不影响内存里待飞入的奖励
      var transientChans = [];
      role.boards.forEach(function (b) {
        if (b && b.channel instanceof Map && b.channel.size > 0) {
          transientChans.push([b, b.channel]);
          b.channel = new Map();
        }
      });
      var data = deepSerialize(role, 0);
      transientChans.forEach(function (p) { p[0].channel = p[1]; });
      nativeLocalStorage.setItem(SAVE_KEY, JSON.stringify(data));
      window.__mockSaveCount = (window.__mockSaveCount || 0) + 1;
      scheduleCloudSync(role, data);
      return true;
    } catch (e) {
      console.warn('[mock-save] 保存失败:', e && e.message);
      return false;
    }
  }
  window.__mockSaveNow = saveNow;

  // role 属性陷阱:客户端登录流程会 reset() 重造 role(new 出来的 createAt 不是 Date),
  //留存统计 createAt.getDay() 会当场崩。任何对象被赋为 role 的瞬间强制规整 createAt。
  function coerceCreateAt(v) {
    if (v && !(v.createAt instanceof Date)) {
      var ca = v.createAt;
      var ms = ca && typeof ca === 'object' && ca.__d !== undefined ? Number(ca.__d) : Number(ca);
      // 旧坏档 {__d:0} 会把 createAt 变成 1970-01-01 并在存档里自我循环,无效值一律修成当前时间
      if (!isFinite(ms) || ms <= 0) ms = Date.now();
      try { v.createAt = new Date(ms); } catch (e) {}
    }
    return v;
  }
  function hardenRoleProperty(holder) {
    try {
      var _r = holder.role;
      Object.defineProperty(holder, 'role', {
        configurable: true, enumerable: true,
        get: function () { return _r; },
        set: function (v) { _r = coerceCreateAt(v); },
      });
    } catch (e) {}
  }
  window.__coerceCreateAt = coerceCreateAt;
  window.__hardenRoleProperty = hardenRoleProperty;
  // 只读调试钩子: 绕过 adapter 直接读原生存档原文 + 最近一次恢复是否成功
  window.__mockLastRestore = { ok: null, err: null };
  window.__readRawSave = function () {
    try { return nativeLocalStorage.getItem(SAVE_KEY); } catch (e) { return '(读失败:' + e.message + ')'; }
  };

  // 引导进度写回 = 正版服务器行为:客户端每完成一个 keyStep 发 game_guidesave({id,step}),
  //服务器写进 role.guide 随 role 下发(引导进度是服务器权威,客户端自己从不写这个 Map)。
  //不写回则 guide 永远空 → 刷新被判"从没做过教程" → 重播 Intro → 挂死 98%
  function applyGuideSave(role, params) {
    try {
      if (!role || !params || params.id == null || params.step == null) return;
      var g = role.guide;
      if (!(g instanceof Map)) { g = role.guide = new Map(); }
      if (!(Number(g.get(params.id)) >= Number(params.step))) { // 只前进不后退(serverStep 语义)
        g.set(params.id, params.step);
        console.log('[mock-network] guide 进度写回:', params.id, '=', params.step);
      }
    } catch (e) {}
  }

  // ===== 订单系统:代服务器写回 =====
  // 考古结论(main-pretty.js):board.orders / board.ordered / board.orderDrawerEndId
  //客户端零写入,全由服务器维护;订单列表渲染源 = board.orders(键 "main:"+orderId,
  //即 mC({kind:"main",orderId}) L29788,值 = ns 形订单对象 L7061)。
  //金币奖励客户端按配置本地发(role.coin+=,L76141,经 currentRole 活体引用自动落档),
  //服务器欠的只有进度:完成→ordered 标记 + 从 orders 移除;整抽屉完成(抽屉号=
  //floor(orderId/1000))→orderDrawerEndId 推进并播种下一抽屉。
  //订单数值全部来自原版解码配置(学习资料/data/orders.json,serve.mjs /config/ 下发)
  var ORDER_CONFIG = null;
  function loadOrderConfig() {
    fetch('/config/orders.json').then(function (r) { return r.json(); }).then(function (d) {
      ORDER_CONFIG = d;
      // 配置可能晚于 rolelogin 到手:补一次播种(幂等,已有活订单时不动);
      //有存档且尚未恢复时跳过——那是客户端 reset 出的空壳 role,不碰也不触发落盘
      var role = window._user_mgr_ && window._user_mgr_.role;
      if (role && (!hasSavedRole() || restoreDone)) {
        ensureOrdersSeeded(role);
        scheduleSave();
      }
    }).catch(function (e) {
      console.error('[mock-order] 订单配置加载失败:', e && e.message);
    });
  }
  function mainOrderKey(orderId) { return 'main:' + orderId; }
  function configOrdersInDrawer(drawerId) {
    var out = [];
    for (var k in ORDER_CONFIG) if (Math.floor(Number(k) / 1000) === drawerId) out.push(Number(k));
    return out.sort(function (a, b) { return a - b; });
  }
  function getBoardFor(role, boardId) {
    if (!role || !role.boards) return null;
    var b = boardId != null ? role.boards.get(Number(boardId)) : null;
    if (b) return b;
    var found = null;
    role.boards.forEach(function (v) { if (!found && v && v.type === 1) found = v; }); // Uo.main=1
    return found;
  }
  function ensureOrdersSeeded(role) {
    if (!ORDER_CONFIG || !role || !role.boards) return;
    role.boards.forEach(function (board) {
      if (!board || board.type !== 1) return; // 只管主棋盘
      if (!board.orders || !(board.orders instanceof Map)) board.orders = new Map();
      if (!board.ordered || !(board.ordered instanceof Map)) board.ordered = new Map();
      if (board.orders.size > 0) return; // 已有活订单(存档/播种过),不重复种
      // 当前抽屉 = 第一个未整抽屉过关、且还有未完成订单的抽屉;只种这一抽屉,
      //未解锁的客户端自己按 order.unlock 过滤隐藏(与真服行为等效)
      var drawers = [];
      for (var k in ORDER_CONFIG) {
        var d = Math.floor(Number(k) / 1000);
        if (drawers.indexOf(d) < 0) drawers.push(d);
      }
      drawers.sort(function (a, b) { return a - b; });
      for (var i = 0; i < drawers.length; i++) {
        if (drawers[i] <= (board.orderDrawerEndId || 0)) continue;
        var unfinished = configOrdersInDrawer(drawers[i]).filter(function (id) { return !board.ordered.has(id); });
        if (unfinished.length <= 0) continue;
        unfinished.forEach(function (id) {
          var c = ORDER_CONFIG[id];
          if (!c) return;
          board.incrementId = (board.incrementId || 0) + 1;
          var demand = new Map();
          for (var eid in (c.demand || {})) demand.set(Number(eid), c.demand[eid]);
          board.orders.set(mainOrderKey(id), {
            id: board.incrementId,
            orderId: id,
            demand: demand,       // 需求 Map<elementId,count> (ns.demand)
            elements: new Map(),  // 已提交记账,初始空
            unlock: c.unlock || [],
            rewards: new Map(),
            rewarded: false,
            state: 0,             // ir.prepare (L6567)
            endTime: 0,
            pauseTime: 0
          });
        });
        console.log('[mock-order] 播种抽屉 ' + drawers[i] + ' 订单 x' + unfinished.length + ' (orderDrawerEndId=' + (board.orderDrawerEndId || 0) + ')');
        break;
      }
    });
  }
  function applyCompleteOrder(role, params) {
    if (!ORDER_CONFIG || !role || !params) return;
    var pid = Number(params.orderId);
    if (!pid) return;
    var board = getBoardFor(role, params.boardId);
    if (!board) return;
    if (!board.ordered || !(board.ordered instanceof Map)) board.ordered = new Map();
    // RPC 的 orderId 字段实为订单实例 id(ns.id:onOrderFinish L70288 取 e.data.id 传入
    //sendCompleteOrderRequest);而 ordered/抽屉推进要按配置 orderId 记账(IsOrderFinish
    //L11321 用配置 id 查 ordered)。真实流程发实例 id,调试钩子发配置 id,两者都兼容:
    //先按实例 id 在活订单表找,命中→翻译成配置 orderId;未命中且是配置 id→直接处理
    var configOrderId = 0, hitKey = null, hitOrder = null;
    if (board.orders instanceof Map) {
      board.orders.forEach(function (v, k) {
        if (hitOrder === null && v && Number(v.id) === pid) { hitKey = k; hitOrder = v; }
      });
    }
    if (hitOrder) {
      configOrderId = Number(hitOrder.orderId);
      board.orders.delete(hitKey);
    } else if (ORDER_CONFIG[pid]) {
      configOrderId = pid;
      board.orders.delete(mainOrderKey(pid));
    }
    // 金币服务器权威入账:客户端 renderReward 展示的币值=CalcCoinValue(Σ Element.
    //orderCoin×demand 数量,同公式同配置),但飞币演出链路不保证执行(教程期/演出
    //异常均被 catch 静默跳过)——服务器必须在响应 role 里把币发好。真实流程发实例
    //id(hitOrder 已翻译成配置号),调试钩子发配置 id,两路统一从配置表 demand 算,
    //与 CalcCoinValue 同源,不再依赖活订单的 demand 字段形态。
    if (configOrderId && ORDER_CONFIG[configOrderId]) {
      var coinGain = 0;
      var demandObj = ORDER_CONFIG[configOrderId].demand || {};
      for (var eid in demandObj) {
        var elc = COOK_INDEX && COOK_INDEX.elem[eid];
        coinGain += ((elc && Number(elc.orderCoin)) || 0) * Number(demandObj[eid]);
      }
      if (coinGain > 0) {
        role.coin = (role.coin || 0) + coinGain;
        console.log('[mock-order] 订单金币入账 +' + coinGain + ' (orderId=' + configOrderId + ')');
      }
    }
    var recordId = configOrderId || pid; // 非配置订单(教程假单等)只记原始 id,无抽屉语义
    if (!board.ordered.has(recordId)) {
      board.ordered.set(recordId, { time: Number(params.timestamp) || Date.now() });
      console.log('[mock-order] 订单完成记账: 实例' + pid + ' → ordered[' + recordId + ']');
      trackWeekTaskProgress(role, 6, 1);
      addPassPoints(role, 10);
      addEnergyPassPoints(role, 10);
    }
    if (configOrderId) {
      var drawerId = Math.floor(configOrderId / 1000);
      var ids = configOrdersInDrawer(drawerId);
      if (ids.length > 0 && (board.orderDrawerEndId || 0) < drawerId &&
          ids.every(function (id) { return board.ordered.has(id); })) {
        board.orderDrawerEndId = drawerId;
        console.log('[mock-order] 抽屉 ' + drawerId + ' 全部完成,orderDrawerEndId 推进');
      }
    }
    ensureOrdersSeeded(role); // 整抽屉清空后种下一抽屉
    // 整抽屉过关→礼盒可领(orderDrawerNeedReward 是客户端发 orderDrawerReward 的唯一
    //闸门:checkReward L64970 只看 has(drawerId);抽屉1 OrderSeries.hide=1 无礼盒 UI,
    //不 set 以还原原版)
    if (configOrderId) {
      var drawerId2 = Math.floor(configOrderId / 1000);
      var os1 = lookupSeries(drawerId2);
      // 整抽屉内配置订单全部完成才可领(原版语义;曾误写成每完成一个订单就 set,
      //客户端 checkReward L64970 每步自动领一盒,奖励越领越多)
      var allDone2 = configOrdersInDrawer(drawerId2).every(function (id) { return board.ordered.has(id); });
      if (os1 && !os1.hide && allDone2 && board.orderDrawerNeedReward instanceof Map &&
          !board.orderDrawerNeedReward.has(drawerId2)) {
        board.orderDrawerNeedReward.set(drawerId2, true);
        console.log('[mock-order] 抽屉 ' + drawerId2 + ' 全部完成,礼盒可领(orderDrawerNeedReward)');
      }
    }
  }

  // ===== 修缮/建造 + 跨天 + 抽屉奖励 + 升级 (B1/B2/B4) =====
  // 考古结论(main-pretty.js):
  //  - build 请求 {buildId,skinId,cellX,cellY,dir}(BuildDetailsWindow.onBuildClick L134410),
  //    响应 {role,rewards,rewards2}(oc 类 L7819)。rewards/rewards2 由 BuildStart 事件直接
  //    消费:动画+展示(L134417/L80160);货币类客户端只展示不入账(CG.AddToRole 仅气泡/收集
  //    走)→ 服务器(本 mock)记账;element 奖励客户端发上运行时棋盘,随 saveNow 同步回 role
  //  - isBuilt 唯一判据=build.builded.get(id)(L11566);解锁链 UnlockAreaX→build.areas.
  //    includes(X)、FinishBuildN→builded.has(N)(bh L11452);新档 areas=[1](Area1 autoUnlock)
  //  - 价格服务器权威(Build.getDemand L126763:nextBuildCoin>0 优先→buildCoinCache→config),
  //    本 mock 恒留 0/空→永远 config 原版价,零发明
  //  - 进度礼盒 rewards2:BuildReward[sheet].count 分段,组内已建数恰达分段末发
  //    progressReward[i](与 locateProgressReward L32751 同规则,builded 只增天然幂等)
  //  - 跨天:currentTimestamp 响应必须带 {ts,dayEnd}(syncRole L117792 无条件
  //    dayEndTime=getData().dayEnd);dayRefresh 后客户端清 daily00Event+emit(DayRefresh)
  //    并重挂钟(registerDayRefreshClock L118341 读 role.dayEndTime)
  //  - 抽屉礼盒奖励=OrderSeries[drawerId].reward;升级=玩家手点(L160522),门槛
  //    expLevel>=PlayerLevel[level+1].exp(L118585),奖励=PlayerLevel.reward
  var TABLES = {}; // 原版解码配置表(serve /config/table/<Name>.json 按需下发)
  function loadGameTables() {
    ['Build', 'BuildReward', 'Area', 'Adron', 'AdronSkin', 'OrderSeries', 'PlayerLevel', 'BoardAreaLock',
     'element', 'elementMultiOrderPool', 'Config', 'Shop', 'Goose', 'Bag', 'launcherBagConfig',
     'weekTask', 'weekProgressReward', 'weekTaskActivity',
     'PassAct', 'PassTask', 'energypassConfig', 'energepassInfo', 'weightRace', 'gymSprint', 'gymSprintTask',
     'PBPassInfo', 'PBPassGift', 'PBPassReward'].forEach(function (name) {
      fetch('/config/table/' + name + '.json').then(function (r) { return r.json(); }).then(function (d) {
        TABLES[name] = d;
        if (name === 'Build') buildIndex();
        if (name === 'Shop') ensureRoleShop(window._user_mgr_ && window._user_mgr_.role); // 表迟到也补
        if (name === 'weekTaskActivity' && d && d.wt1) d.wt1.unlock = []; // 开放周任务测试
        buildCookIndex(); // 幂等,三表齐才出结果
      }).catch(function (e) {
        console.error('[mock-build] 配置表加载失败 ' + name + ':', e && e.message);
      });
    });
  }
  // Build={"Area1":{"1001":{...}}} 带 sheet 层;OrderSeries 同构;BoardAreaLock/PlayerLevel 平铺
  function tableEntries(table) {
    var out = [];
    if (!table) return out;
    for (var k in table) {
      var v = table[k];
      if (v && typeof v === 'object' && v.id !== undefined && v.constructor === Object) out.push(v);
      else if (v && typeof v === 'object') out = out.concat(tableEntries(v)); // sheet 层下钻
    }
    return out;
  }
  var BUILD_INDEX = null; // {byId, groupById(=sheet 名), adornSteps(=客户端 adorn2steps 同构)}
  function buildIndex() {
    var B = TABLES.Build;
    if (!B) return;
    var idx = { byId: {}, groupById: {}, adornSteps: {} };
    for (var sheet in B) {
      for (var id in B[sheet]) {
        var e = B[sheet][id];
        if (!e || e.id === undefined) continue;
        idx.byId[e.id] = e;
        idx.groupById[e.id] = sheet;
        for (var rk in (e.reward || {})) {
          var am = /^(?:Adorn|Adron)(\d+)$/.exec(rk); // 奖励键拼写=Adorn,装饰定义表名=Adron,两者都收
          if (am) {
            var aid = Number(am[1]);
            var steps = idx.adornSteps[aid] || [];
            steps.push(e.id);
            idx.adornSteps[aid] = steps;
          }
        }
      }
    }
    for (var a in idx.adornSteps) idx.adornSteps[a].sort(function (x, y) { return x - y; });
    BUILD_INDEX = idx;
  }
  // 奖励 key 词法(实测 Build/OrderSeries/BoardAreaLock/PlayerLevel 词根):
  //纯数字=element(fr=7),Adron<id>(8),goose<id>(14),Area<id>(13),Coin(1)/Diamond(2)/
  //Exp(3)/Energy(4)/SpeedUpCoupon(5);value 字段名实锤自 PrintRewards(L77545)
  function parseRewardMap(obj) {
    var out = [];
    if (!obj) return out;
    for (var k in obj) {
      var v = Number(obj[k]) || 0;
      if (!v) continue;
      var m;
      if (/^\d+$/.test(k)) out.push({ itemType: 7, itemId: Number(k), value: v });
      else if ((m = /^(?:Adorn|Adron)(\d+)$/.exec(k))) out.push({ itemType: 8, itemId: Number(m[1]), value: v });
      else if ((m = /^goose(\d+)$/.exec(k))) out.push({ itemType: 14, itemId: Number(m[1]), value: v });
      else if ((m = /^Area(\d+)$/.exec(k))) out.push({ itemType: 13, itemId: Number(m[1]), value: v });
      else if (k.toLowerCase() === 'coin') out.push({ itemType: 1, itemId: 0, value: v });
      else if (k.toLowerCase() === 'diamond') out.push({ itemType: 2, itemId: 0, value: v });
      else if (k.toLowerCase() === 'exp') out.push({ itemType: 3, itemId: 0, value: v });
      else if (k.toLowerCase() === 'energy') out.push({ itemType: 4, itemId: 0, value: v });
      else if (k.toLowerCase() === 'speedupcoupon') out.push({ itemType: 5, itemId: 0, value: v });
      else if ((m = /^film(\d+)$/.exec(k))) out.push({ itemType: 35, itemId: Number(m[1]), value: v });
      else if (k === 'PassPoint') out.push({ itemType: 22, itemId: 0, value: v });
    }
    return out;
  }
  // element 奖励落通道(真服权威行为):sendElementsToBoard(L76605)只消费
  //o3.Data.channel —— 遍历条目要求 itemType==element 且 id>0 且 value>0,按
  //itemId 匹配 rewards,value 即数量;channelPut/取出时客户端自己同步删活体
  //role.boards 和缓存两处(removeBoardElementChannelItem L76702),存档由
  //saveNow 闭环。故 mock 只写活体主棋盘 channel,key=itemId(fa.id>0 硬条件,
  //同 itemId 聚合 value),字段与 fa 类(L6760)同构
  function grantChannelElements(role, items, from) {
    var board = getBoardFor(role);
    if (!board) return 0;
    if (!(board.channel instanceof Map)) board.channel = new Map();
    var n = 0;
    (items || []).forEach(function (it) {
      if (!it || it.itemType !== 7) return;
      var ex = board.channel.get(it.itemId);
      if (ex) ex.value = (ex.value || 0) + it.value;
      else board.channel.set(it.itemId, {
        id: it.itemId, itemType: 7, itemId: it.itemId,
        value: it.value, state: 0, from: from || '', bagId: 0
      });
      n++;
    });
    return n;
  }
  // channel 是瞬态奖励载体:真服把"待飞入的 element"写进 role.boards[main].channel,
  //客户端 sendElementsToBoard 消费飞入棋盘 cells 后即清空。若 mock 侧残留(客户端
  //消费的是它自己的 o3.Data.channel 副本,未回写 mock 活体),下次全量下发 role 会把
  //残留 element 重新飞入 = "切回棋盘自动发奖励"。故:①落盘前摘除不持久化;②全量
  //role 下发前清空(奖励飞入已完成的瞬态,清空不丢数据,element 已在 cells 里)
  function stripTransientChannel(role) {
    if (role && role.boards instanceof Map) role.boards.forEach(function (b) {
      if (b && b.channel instanceof Map) b.channel = new Map();
    });
  }
  // role.shop = Map<groupId, {aid, groupId, goods:[商品实例], refreshTime}>(ai 类 L7141)
  //是服务器下发的货架数据,真服必带;ElementDetailWindow 打开即调 oG.SearchElement
  //(L74509 `d3.role.shop.get(2).goods` 无空保护)——缺 key=2 会 TypeError,窗口基类
  //catch 后 ChangeViewState(ERROR),modalBlocker 残留挡住全屏触摸(=点感叹号无反应
  //且主界面点击失效的根因)。商品实例 {id, content:[]} 即可:GetShopConf(L53459)在
  //content 为空时回落到 config.Shop 原版配置,零发明;货架 key=columnId(原版商品
  //按列分组:1 杂货/2 元素/4/5),元素货架 key=2 正是 SearchElement 扫的那组
  var _SHOP_PRICE_TYPES = { none: 1, free: 2, coin: 3, diamond: 4, ad: 5, cash: 6, energy: 7 };
  var _ELEMENT_SHOP_PRESETS = {
    2001: { elemId: 1001101, pType: 3, pVal: 100 }, // 辣椒 Lv1, 100金币
    2002: { elemId: 1001102, pType: 3, pVal: 200 }, // 生菜 Lv2, 200金币
    2003: { elemId: 1002101, pType: 4, pVal: 15 },  // 小冰柜 Lv1, 15钻
    2004: { elemId: 1003101, pType: 3, pVal: 150 }, // 调料 Lv1, 150金币
    2005: { elemId: 1001101, pType: 5, pVal: 0 },   // 辣椒 Lv1, 广告免费
    2006: { elemId: 1001103, pType: 4, pVal: 25 }   // 番茄 Lv3, 25钻
  };

  function buildShopGoodsItem(id, colId) {
    var conf = TABLES.Shop ? TABLES.Shop[id] : null;
    var pType = _SHOP_PRICE_TYPES.none;
    var pVal = 0;
    var redDot = false;
    var content = [];

    if (conf) {
      if (conf.diamondRange && conf.diamondRange.length > 0) {
        pType = _SHOP_PRICE_TYPES.diamond;
        pVal = Number(conf.diamondRange[0]) || 0;
        if (pVal === 0) redDot = true; // 免费商品(如 1002 宝箱)
      } else if (conf.coinRange && conf.coinRange.length > 0) {
        pType = _SHOP_PRICE_TYPES.coin;
        pVal = Number(conf.coinRange[0]) || 0;
      } else if (conf.Energy && conf.Energy.length > 0) {
        pType = _SHOP_PRICE_TYPES.energy;
        pVal = Number(conf.Energy[0]) || 0;
      } else if (conf.ad > 0 || conf.adCount > 0) {
        pType = _SHOP_PRICE_TYPES.ad;
        pVal = 0;
      } else if (conf.cash > 0) {
        pType = _SHOP_PRICE_TYPES.cash;
        pVal = Number(conf.cash) || 0;
      }
    }

    if (colId === 2) {
      var preset = _ELEMENT_SHOP_PRESETS[id] || { elemId: 1001101, pType: 3, pVal: 100 };
      content = [{
        id: preset.elemId,
        itemType: 7,
        itemId: preset.elemId,
        value: 1,
        state: 0,
        from: 'shop',
        bagId: 0
      }];
      pType = preset.pType;
      pVal = preset.pVal;
    }

    return {
      id: Number(id),
      shopType: 1,
      priceType: pType,
      priceValue: pVal,
      buyedCount: 0,
      limitTime: 0,
      redDot: redDot,
      content: content
    };
  }

  function ensureRoleShop(role) {
    if (!role) return false;
    if (!(role.shop instanceof Map)) role.shop = new Map();
    var byCol = {};
    tableEntries(TABLES.Shop).forEach(function (e) {
      if (!e || !e.id) return;
      var col = Number(e.columnId) || 2;
      (byCol[col] = byCol[col] || []).push(Number(e.id));
    });
    var updated = 0;
    Object.keys(byCol).forEach(function (col) {
      var cid = Number(col);
      var ex = role.shop.get(cid);
      if (!ex || !Array.isArray(ex.goods) || ex.goods.length === 0) {
        role.shop.set(cid, {
          aid: 0,
          groupId: cid,
          goods: byCol[col].sort(function (a, b) { return a - b; }).map(function (id) {
            return buildShopGoodsItem(id, cid);
          }),
          refreshTime: 0
        });
        updated++;
      } else {
        // 对已有货架进行字段完备性补全（老档兼容,防止 priceType undefined 导致 $r 崩溃）
        ex.goods.forEach(function (g) {
          if (!g.priceType || (cid === 2 && (!g.content || g.content.length === 0))) {
            var fresh = buildShopGoodsItem(g.id, cid);
            if (!g.priceType) {
              g.priceType = fresh.priceType;
              g.priceValue = fresh.priceValue;
              g.shopType = 1;
              g.buyedCount = g.buyedCount || 0;
              if (fresh.redDot && !g.buyedCount) g.redDot = true;
            }
            if (cid === 2 && (!g.content || g.content.length === 0)) {
              g.content = fresh.content;
            }
            updated++;
          }
        });
      }
    });
    if (updated) console.log('[mock-shop] 已维护/更新 Shop 货架,变更批次:', updated);
    return updated > 0;
  }

  function applyShopBuy(role, params) {
    if (!role || !role.shop || !params) return { code: 1, rewards: [] };
    var itemId = Number(params.itemId);
    var targetGoods = null;
    var targetCol = 0;

    role.shop.forEach(function (col, colId) {
      if (col && Array.isArray(col.goods)) {
        col.goods.forEach(function (g) {
          if (g && g.id === itemId) {
            targetGoods = g;
            targetCol = colId;
          }
        });
      }
    });

    if (!targetGoods) {
      console.warn('[mock-shop] 未知商品 itemId:', itemId);
      return { code: 1, rewards: [] };
    }

    var pType = targetGoods.priceType;
    var pVal = targetGoods.priceValue || 0;
    if (pType === _SHOP_PRICE_TYPES.coin) {
      if ((role.coin || 0) < pVal) {
        console.warn('[mock-shop] 金币不足(需' + pVal + ' 现有' + role.coin + ')');
        return { code: 1, rewards: [] };
      }
      role.coin -= pVal;
    } else if (pType === _SHOP_PRICE_TYPES.diamond) {
      if ((role.diamond || 0) < pVal) {
        console.warn('[mock-shop] 钻石不足(需' + pVal + ' 现有' + role.diamond + ')');
        return { code: 1, rewards: [] };
      }
      role.diamond -= pVal;
    }

    targetGoods.buyedCount = (targetGoods.buyedCount || 0) + 1;
    targetGoods.redDot = false;

    var rewards = [];
    if (Array.isArray(targetGoods.content) && targetGoods.content.length > 0) {
      rewards = targetGoods.content.map(function (c) {
        return { itemType: c.itemType || 7, itemId: c.itemId || c.id, value: c.value || 1 };
      });
    } else {
      var conf = TABLES.Shop ? TABLES.Shop[itemId] : null;
      if (conf && conf.goods) {
        rewards = parseRewardMap(conf.goods);
      }
    }

    grantCurrency(role, rewards);
    grantChannelElements(role, rewards);

    console.log('[mock-shop] 购买成功 itemId:', itemId, '扣款 pType:', pType, 'pVal:', pVal, '奖励:', JSON.stringify(rewards));
    return { code: 0, rewards: rewards };
  }

  var _ELEMENT_SHOP_CANDIDATES = [
    { elemId: 1001101, pType: 3, pVal: 80 },   // 辣椒 Lv1, 80金币
    { elemId: 1001102, pType: 3, pVal: 160 },  // 生菜 Lv2, 160金币
    { elemId: 1001103, pType: 4, pVal: 15 },   // 番茄 Lv3, 15钻
    { elemId: 1001201, pType: 3, pVal: 80 },   // 菜籽 Lv1, 80金币
    { elemId: 1001202, pType: 3, pVal: 160 },  // 菜苗 Lv2, 160金币
    { elemId: 1002101, pType: 4, pVal: 12 },   // 小冰柜 Lv1, 12钻
    { elemId: 1002102, pType: 4, pVal: 25 },   // 冰盒 Lv2, 25钻
    { elemId: 1003101, pType: 3, pVal: 100 },  // 调料 Lv1, 100金币
    { elemId: 1003102, pType: 3, pVal: 200 },  // 调料 Lv2, 200金币
    { elemId: 1004101, pType: 3, pVal: 90 },   // 茶包 Lv1, 90金币
    { elemId: 1004102, pType: 3, pVal: 180 },  // 茶叶 Lv2, 180金币
    { elemId: 1001101, pType: 5, pVal: 0 },    // 辣椒 Lv1, 广告免费
    { elemId: 1001201, pType: 5, pVal: 0 }     // 菜籽 Lv1, 广告免费
  ];

  function applyShopRefresh(role, params) {
    if (!role || !role.shop || !params) return { code: 1 };
    var groupId = Number(params.groupId) || 2;
    var col = role.shop.get(groupId);
    if (!col) return { code: 1 };

    // 刷新费用 10 钻(扣除或免除,确保不阻断)
    if ((role.diamond || 0) >= 10) {
      role.diamond -= 10;
    }

    if (Array.isArray(col.goods)) {
      // 随机打乱挑选新一批元素与价格
      var pool = _ELEMENT_SHOP_CANDIDATES.slice().sort(function () { return Math.random() - 0.5; });
      col.goods.forEach(function (g, idx) {
        g.buyedCount = 0;
        g.redDot = false;
        if (groupId === 2) {
          var pick = pool[idx % pool.length];
          g.priceType = pick.pType;
          g.priceValue = pick.pVal;
          if (pick.pVal === 0) g.redDot = true;
          g.content = [{
            id: pick.elemId,
            itemType: 7,
            itemId: pick.elemId,
            value: 1,
            state: 0,
            from: 'shop',
            bagId: 0
          }];
        }
      });
    }
    col.refreshTime = Date.now() + 3600 * 1000;
    console.log('[mock-shop] 刷新货架成功 groupId:', groupId, '已重新随机生成全部商品与价格');
    return { code: 0 };
  }
  function grantCurrency(role, items) {
    (items || []).forEach(function (it) {
      if (it.itemType === 1) role.coin = (role.coin || 0) + it.value;
      else if (it.itemType === 2) role.diamond = (role.diamond || 0) + it.value;
      else if (it.itemType === 3) role.expLevel = (role.expLevel || 0) + it.value;
      else if (it.itemType === 4 && role.energy) role.energy.value = (role.energy.value || 0) + it.value;
      else if (it.itemType === 5) role.speedUpCoupon = (role.speedUpCoupon || 0) + it.value;
      else if (it.itemType === 22) addPassPoints(role, it.value);
    });
  }
  function getDefaultSkinId(adornId) {
    adornId = Number(adornId);
    var skins = TABLES.AdronSkin;
    if (skins) {
      var groups = Object.values(skins);
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        if (group && typeof group === 'object') {
          for (var sid in group) {
            var s = group[sid];
            if (s && Number(s.adornId) === adornId && (s.isDefault === 1 || s.isDefault === '1')) {
              return Number(s.id);
            }
          }
        }
      }
    }
    return adornId * 100 + 1;
  }

  function applyChannelPut(role, params) {
    if (!role || !role.boards || !params) return null;
    var boardId = Number(params.boardId) || 1;
    var board = role.boards.get(boardId);
    if (!board) return null;
    var toIndex = Number(params.toIndex);
    var channelItemId = Number(params.id);

    // 1. 从 channel 中找到该待飞入物品
    var targetChannelItem = null;
    if (board.channel instanceof Map) {
      targetChannelItem = board.channel.get(channelItemId);
    }
    if (!targetChannelItem) {
      console.warn('[mock-channel] 通道中未找到物品 id:', channelItemId);
      return null;
    }

    var elemId = targetChannelItem.itemId || targetChannelItem.id;

    // 2. 扣除或移出 channel
    if (targetChannelItem.value > 1) {
      targetChannelItem.value -= 1;
    } else {
      board.channel.delete(channelItemId);
    }

    // 3. 在 board.cells 的 toIndex 生成新格子(GdCell 结构)
    if (!(board.cells instanceof Map)) board.cells = new Map();
    var newCell = {
      uUID: toIndex + 1,
      seed: 0,
      index: toIndex,
      elementId: elemId,
      state: 0,
      productType: 0,
      bubbleEnd: 0,
      deteriorateEnd: 0,
      openEnd: 0,
      pauseTime: 0,
      endTime: 0,
      processTime: 0,
      skills: new Map(),
      order: { id: 0, orderId: 0, demand: new Map(), elements: new Map(), unlock: [], rewards: new Map(), rewarded: false, state: 0, endTime: 0, pauseTime: 0 },
      orderBegin: [],
      hp: new Map(),
      recovery: null,
      productCount: 0,
      extra: new Map()
    };
    board.cells.set(toIndex, newCell);

    console.log('[mock-channel] 物品从通道飞入棋盘 toIndex:', toIndex, 'elemId:', elemId, 'channel剩余:', board.channel.size);
    return newCell;
  }

  function applyBuild(role, params) {
    if (!BUILD_INDEX || !role || !role.build || !params) return null;
    var buildId = Number(params.buildId);
    var conf = BUILD_INDEX.byId[buildId];
    if (!conf) { console.warn('[mock-build] 未知 buildId:', buildId); return null; }
    var b = role.build;
    var price = Number((conf.demand || {}).Coin) || 0;
    // 扣除金币: 玩家点击修缮即执行消费
    if (price > 0) {
      role.coin = Math.max(0, (Number(role.coin) || 0) - price);
    }
    b.builded.set(buildId, true);          // isBuilt 唯一判据
    b.builds.set(buildId, { id: buildId, state: 1 }); // 1 为完成态(2为未完成)
    try {
      if (typeof window !== 'undefined' && window.d3 && window.d3.role) {
        window.d3.role.coin = role.coin;
        if (window.d3.role.build) {
          if (window.d3.role.build.builded) window.d3.role.build.builded.set(buildId, true);
          if (window.d3.role.build.builds) window.d3.role.build.builds.set(buildId, { id: buildId, state: 1 });
        }
      }
    } catch (e) {}
    var rewards = parseRewardMap(conf.reward);
    rewards.forEach(function (it) {
      if (it.itemType === 8) { // 装饰上街:Ya(L6998) level=多步序号(0 基,同 adorn2steps)
        var steps = BUILD_INDEX.adornSteps[it.itemId] || [buildId];
        var defaultSkin = getDefaultSkinId(it.itemId);
        var ex = b.adorns.get(it.itemId) || { id: it.itemId, level: 0, cellX: 0, cellY: 0, dir: 0, usingId: defaultSkin, buyed: new Map() };
        ex.level = steps.indexOf(buildId) >= 0 ? steps.indexOf(buildId) : ex.level + 1;
        if (Number(params.cellX)) ex.cellX = Number(params.cellX);
        if (Number(params.cellY)) ex.cellY = Number(params.cellY);
        if (Number(params.dir)) ex.dir = Number(params.dir);
        // 核心修复: usingId 绝不能为 0! 否则 isAdornBuiltByData 判 false 导致 updateSkin 放弃加载实物 Prefab
        ex.usingId = Number(params.skinId) || ex.usingId || defaultSkin;
        b.adorns.set(it.itemId, ex);
        try {
          if (typeof window !== 'undefined' && window.d3 && window.d3.role && window.d3.role.build && window.d3.role.build.adorns) {
            window.d3.role.build.adorns.set(it.itemId, ex);
          }
        } catch (e) {}
      } else if (it.itemType === 13) { // 新街区解锁
        if (b.areas.indexOf(it.itemId) < 0) b.areas.push(it.itemId);
      } else if (it.itemType === 14 && role.goose && role.goose.gooses instanceof Map) {
        // 新肥鹅:is 类(L7112) gooses Map<gooseId,{rewarded:false}>
        if (!role.goose.gooses.has(it.itemId)) role.goose.gooses.set(it.itemId, { rewarded: false });
      }
      // itemType 7(element):同样必须写 channel —— 客户端 BuildStart 的元素飞入
      //演算(sendElementsToBoard)只消费 channel,不消费 rewards;真服把 element
      //写进响应 role(含 channel),下方统一落账
    });
    grantCurrency(role, rewards); // Exp/Energy/SpeedUpCoupon 等服务器入账
    grantChannelElements(role, rewards, 'build');
    // 进度礼盒:组内已建数恰达 count 分段末
    var rewards2 = [];
    var group = BUILD_INDEX.groupById[buildId];
    var br = TABLES.BuildReward && TABLES.BuildReward[group];
    if (br && br.count) {
      var r = 0;
      b.builded.forEach(function (v, k) { if (v && BUILD_INDEX.groupById[k] === group) r++; });
      var cum = 0;
      for (var i = 0; i < br.count.length; i++) {
        cum += Number(br.count[i]) || 0;
        if (r === cum) {
          rewards2 = parseRewardMap((br.progressReward || [])[i]);
          grantCurrency(role, rewards2);
          grantChannelElements(role, rewards2, 'buildProgress');
          break;
        }
      }
    }
    console.warn('[mock-build] 建造成功 ' + buildId + '(组:' + group + ') 扣币' + price + ' 剩余币:' + role.coin + ' 奖励x' + rewards.length + (rewards2.length ? ' 礼盒x' + rewards2.length : ''));
    saveNow(); // 立即同步落盘，绝不让异常刷新导致建造进度丢失回滚
    return { rewards: rewards, rewards2: rewards2 };
  }
  function lookupSeries(drawerId) {
    var os = TABLES.OrderSeries;
    if (!os) return null;
    return os[drawerId] || (os.Main && os.Main[drawerId]) || null;
  }
  // 抽屉礼盒领取:奖励=OrderSeries[drawerId].reward,领后清 needReward 标记。
  //element 类必须写 channel —— ShowReward/BoxWindow 只是演出(纯动画零落账),
  //真服把 element 写进响应 role.boards[main].channel 由 Orange syncData 合并
  function applyDrawerReward(role, params) {
    var board = getBoardFor(role);
    var drawerId = Number(params && params.drawerId);
    var conf = lookupSeries(drawerId);
    var rewards = conf ? parseRewardMap(conf.reward) : [];
    if (board && board.orderDrawerNeedReward instanceof Map) board.orderDrawerNeedReward.delete(drawerId);
    grantCurrency(role, rewards);
    grantChannelElements(role, rewards, 'drawer');
    trackWeekTaskProgress(role, 5, 1);
    addPassPoints(role, 30);
    addEnergyPassPoints(role, 30);
    console.log('[mock-order] 抽屉礼盒 ' + drawerId + ' 发放,奖励x' + rewards.length);
    scheduleSave();
    return { rewards: rewards };
  }
  // 街区进度奖励领取(AreaDetailsWindow.onClickGetReward L134253):Area[Main][areaId].reward
  function applyAreaRewardGet(role, params) {
    if (!role || !role.build) return { rewards: [] };
    var areaId = Number(params && params.areaId);
    var key = 'Area' + areaId; // areaReward Map<键,领取记录>,键用区域标识防重领
    if (role.build.areaReward.has(key)) return { rewards: [] };
    var conf = TABLES.Area && TABLES.Area.Main && TABLES.Area.Main[areaId];
    var rewards = conf ? parseRewardMap(conf.reward) : [];
    role.build.areaReward.set(key, { id: areaId, time: Date.now() });
    grantCurrency(role, rewards);
    grantChannelElements(role, rewards, 'area');
    scheduleSave();
    return { rewards: rewards };
  }
  // 棋盘区域锁奖励(MergeBoardAreaBoxReward L99055):{boardId,areaLockId,timestamp},
  //奖励=BoardAreaLock[id].rewards;areaRewarded 标记客户端领后自删运行时副本,这里同步删
  //role 侧防刷新复活
  function applyClaimBoardAreaReward(role, params) {
    var board = getBoardFor(role, params && params.boardId);
    var lockId = Number(params && params.areaLockId);
    var conf = TABLES.BoardAreaLock && TABLES.BoardAreaLock[lockId];
    var rewards = conf ? parseRewardMap(conf.rewards) : [];
    if (board && board.areaRewarded instanceof Map) board.areaRewarded.delete(lockId);
    grantCurrency(role, rewards);
    grantChannelElements(role, rewards, 'areaLock');
    scheduleSave();
    return { rewards: rewards };
  }
  // 肥鹅图鉴领取(GooseHandbookItem.onClickClaim L159695 → Od.gooseReward{gooseId}):
  //奖励=Goose[id].unlockReward(如{"Diamond":10});客户端领后只本地藏图标,防重领靠
  //服务器把 gooses[gooseId].rewarded 置 true(hasUnclaimed 遍历 gooses 看 t.rewarded)
  function applyGooseReward(role, params) {
    var gooseId = Number(params && params.gooseId);
    var conf = null;
    var G = TABLES.Goose;
    if (G) {
      conf = G[gooseId];
      if (!conf || conf.id === undefined) for (var k in G) { // sheet 层兜底
        if (G[k] && typeof G[k] === 'object' && G[k][gooseId]) { conf = G[k][gooseId]; break; }
      }
    }
    var rewards = conf ? parseRewardMap(conf.unlockReward) : [];
    if (role.goose && role.goose.gooses instanceof Map) {
      var g = role.goose.gooses.get(gooseId);
      if (g) g.rewarded = true;
      else role.goose.gooses.set(gooseId, { rewarded: true });
    }
    grantCurrency(role, rewards);
    grantChannelElements(role, rewards, 'goose');
    scheduleSave();
    return { rewards: rewards };
  }
  // 图鉴礼包领取(ElementCollectionItem.onClickGift L141611 → Od.elementHandBookReward
  //{elementId,timestamp}):奖励=Element[id].unlockReward(如{"SpeedUpCoupon":3});客户端
  //领后本地 gh.SetRewarded 置1,但重登/重开窗口走 getElementHandBook 重拉,须持久记
  //handbookRewarded 防复活;响应 rewards[0] 被客户端取 itemType 打点,必须非空
  function applyElementHandBookReward(role, params) {
    var elementId = Number(params && params.elementId);
    var conf = COOK_INDEX && COOK_INDEX.elem[elementId];
    var rewards = conf ? parseRewardMap(conf.unlockReward) : [];
    if (!(role.handbookRewarded instanceof Map)) role.handbookRewarded = new Map();
    role.handbookRewarded.set(elementId, 1);
    grantCurrency(role, rewards);
    grantChannelElements(role, rewards, 'handbook');
    scheduleSave();
    return { rewards: rewards };
  }
  // 图鉴数据源(getElementHandBook{timestamp} → {handbook: Map<elementId,0|1>}):0=已解锁
  //未领,1=已领。gh.Initialize(L11244)拿响应整体覆盖本地 _data,须返回全量。known 从
  //棋盘 cells 实时派生(合成出的元素都在棋盘上),已领的用 handbookRewarded 覆盖;合掉
  //且未领的元素会从图鉴消失(边缘,真服有完整历史记录,当前阶段可接受)
  function buildHandbook(role) {
    var hb = new Map();
    var rewarded = role.handbookRewarded instanceof Map ? role.handbookRewarded : new Map();
    if (role.boards instanceof Map) role.boards.forEach(function (board) {
      if (!board || !(board.cells instanceof Map)) return;
      board.cells.forEach(function (cell) {
        var eid = cell && cell.elementId;
        if (eid > 0) hb.set(eid, rewarded.has(eid) ? 1 : 0);
      });
    });
    rewarded.forEach(function (v, eid) { if (!hb.has(eid)) hb.set(eid, 1); });
    return hb;
  }
  // 玩家升级(手点按钮 L160522):门槛 expLevel>=PlayerLevel[level+1].exp(L118585)
  function applyLevelUp(role) {
    if (!role) return { ok: false, rewards: [] };
    var lvl = role.level || 0;
    var next = TABLES.PlayerLevel && TABLES.PlayerLevel[lvl + 1];
    if (!next) return { ok: false, rewards: [] };
    if ((role.expLevel || 0) < (Number(next.exp) || 0)) return { ok: false, rewards: [] };
    role.level = lvl + 1;
    var rewards = parseRewardMap(next.reward);
    grantCurrency(role, rewards);
    grantChannelElements(role, rewards, 'levelup');
    console.log('[mock-build] 升级 → Lv' + role.level);
    scheduleSave();
    return { ok: true, rewards: rewards };
  }
  // ===== 跨天(B2) =====
  // 原版语义:dayEnd=自然日界(当天 24:00),不以登录时间为准。initRole 的兜底只对无存档
  //新档生效——有存档时原样保留(哪怕已过期):过期值正是触发 dayRefresh 的正确输入,
  //每次启动推 +24h 会把日界永久顶出去,玩家永远跨不了天(旧版 initRole 的雷)
  function endOfToday() {
    var d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }
  function applyDayRefresh(role) {
    if (!role) return { dayEnd: endOfToday() };
    role.dayEndTime = endOfToday(); // 已过旧日界,"现在"所在日的 24:00 必然在未来
    console.log('[mock-day] 跨天记账完成,新 dayEnd=' + new Date(role.dayEndTime).toLocaleString());
    scheduleSave();
    return { dayEnd: role.dayEndTime };
  }

  // ===== 做饭链 (B3, cookV2) =====
  // 架构考古:客户端乐观演算驱动完整订单状态机(UpdateOrderState L74995: prepare→
  //prepared→running(endTime=serverTime+Element.cookEffic×pool.duration 本地算)→
  //complete;加速/收菜全本地)。服务器职责=确认者。cookStart 响应唯一硬校验=
  //GetActionCellRemoteCell(L116756):先读响应 cells 数组(.find(e.index==i))→再 fallback
  //response.role.boards / d3.role.boards 活体;cell.order 须 orderId==菜谱id &&
  //state>=running,否则 "authoritative-mismatch" 整板远端重建。运行时棋盘→活体 role
  //同步有 600ms 防抖,开火瞬间活体可能还是旧值 → mock 用同构推理+同配置公式写活体,
  //并在响应带 cells:[活体cell] 引用,校验必命中。投料/取料同理在活体记账,
  //后续 saveNow 的运行时同步(整 cells 替换)会把权威值覆盖回来,天然幂等。
  //菜谱=elementMultiOrderPool(Kp 包装:cookware=elementOrderId 负数,
  //ingredients=needElements,dish=elementIdWeight 首键),同构 qp.findReadyRecipes→l[0]
  var COOK_INDEX = null;
  function buildCookIndex() {
    var pool = TABLES.elementMultiOrderPool, el = TABLES.element;
    if (!pool || !el || COOK_INDEX) return;
    var out = { pool: [], elem: {} };
    for (var s in el) for (var id in el[s]) {
      var e = el[s][id];
      if (e && e.id !== undefined) out.elem[e.id] = e;
    }
    for (var s2 in pool) {
      var ent = pool[s2];
      if (ent && ent.id !== undefined && ent.elementOrderId !== undefined) out.pool.push(ent);
    }
    COOK_INDEX = out;
    console.log('[mock-cook] 菜谱索引就绪: ' + out.pool.length + ' 菜谱 / ' + Object.keys(out.elem).length + ' 元素');
  }
  function cookCalcDuration(recipeId, cookwareElemId) {
    var r = null, i;
    for (i = 0; i < COOK_INDEX.pool.length; i++) if (COOK_INDEX.pool[i].id === recipeId) { r = COOK_INDEX.pool[i]; break; }
    var e = COOK_INDEX.elem[cookwareElemId];
    if (!r || !e) return 0;
    return Math.ceil((Number(e.cookEffic) || 0) * (Number(r.duration) || 0) * 1000);
  }
  function cookFindRecipe(elementOrderId, elementsMap) {
    var m = elementsMap instanceof Map ? elementsMap : new Map();
    for (var i = 0; i < COOK_INDEX.pool.length; i++) {
      var p = COOK_INDEX.pool[i];
      if (p.elementOrderId !== elementOrderId) continue;
      var ok = true;
      for (var k in (p.needElements || {})) {
        if ((m.get(Number(k)) || 0) < Number(p.needElements[k])) { ok = false; break; }
      }
      if (ok) return p;
    }
    return null;
  }
  function ensureCellOrder(cell) {
    if (!cell.order) cell.order = { id: 0, orderId: 0, demand: new Map(), elements: new Map(), unlock: [], rewards: new Map(), rewarded: false, state: 0, endTime: 0, pauseTime: 0 };
    if (!(cell.order.elements instanceof Map)) cell.order.elements = new Map();
    return cell.order;
  }
  // 开火:推菜谱→running+endTime;返回活体 cell 供响应 cells 数组引用
  function applyCookStart(role, params) {
    if (!COOK_INDEX) return null;
    var board = getBoardFor(role, params && params.boardId);
    var cell = board && board.cells && board.cells.get(Number(params.index));
    if (!cell) return null;
    var order = ensureCellOrder(cell);
    var now = Date.now();
    var recipe = null, i;
    if (order.orderId > 0) { // 客户端乐观值已同步到活体(同构确认)
      for (i = 0; i < COOK_INDEX.pool.length; i++) if (COOK_INDEX.pool[i].id === order.orderId) { recipe = COOK_INDEX.pool[i]; break; }
    }
    if (!recipe) { // 防抖窗口内活体还是旧值→按投料推理(与客户端 qp.findReadyRecipes 同构)
      var eo = (COOK_INDEX.elem[cell.elementId] || {}).elementOrderId;
      if (eo < 0) recipe = cookFindRecipe(eo, order.elements);
    }
    if (!recipe) {
      console.warn('[mock-cook] cookStart 无法匹配菜谱 idx=' + params.index + ' elem=' + cell.elementId + ' 已投' + order.elements.size + ' 种');
      return null;
    }
    order.id = recipe.id;
    order.orderId = recipe.id;
    order.state = 2; // ir.running
    order.endTime = now + cookCalcDuration(recipe.id, cell.elementId);
    if (!Array.isArray(order.orderBegin)) order.orderBegin = [];
    order.orderBegin.push(now);
    console.log('[mock-cook] 开火 idx=' + params.index + ' 菜谱' + recipe.id + ' elem=' + cell.elementId + ' 时长' + Math.round((order.endTime - now) / 1000) + 's');
    scheduleSave();
    return cell;
  }
  // 投料:灶具侧 elements+1 / hiddenPocket 记一枚(运行时同步稍后覆盖成权威值,幂等)
  function applyCookPut(role, params) {
    var board = getBoardFor(role, params && params.boardId);
    var cell = board && board.cells && board.cells.get(Number(params.index));
    if (!cell || !params.ingredientId) return;
    var order = ensureCellOrder(cell);
    var eid = Number(params.ingredientId);
    order.elements.set(eid, (order.elements.get(eid) || 0) + 1);
    if (!Array.isArray(cell.hiddenPocket)) cell.hiddenPocket = [];
    cell.hiddenPocket.push({ elementId: eid });
  }
  // 取料:elements-1 / hiddenPocket 删一枚(客户端本地已把元素放回棋盘 toIndex)
  function applyCookTake(role, params) {
    var board = getBoardFor(role, params && params.boardId);
    var cell = board && board.cells && board.cells.get(Number(params.index));
    if (!cell || !params.eleId) return;
    var order = ensureCellOrder(cell);
    var eid = Number(params.eleId);
    var n = order.elements.get(eid) || 0;
    if (n > 1) order.elements.set(eid, n - 1); else order.elements.delete(eid);
    if (Array.isArray(cell.hiddenPocket)) {
      for (var i = 0; i < cell.hiddenPocket.length; i++) {
        if (cell.hiddenPocket[i] && cell.hiddenPocket[i].elementId === eid) { cell.hiddenPocket.splice(i, 1); break; }
      }
    }
  }
  // 停止烹饪:扣 Config.cookStopCost 钻石,清订单(食材不退,与原版停止确认窗语义一致)
  function applyCookCancel(role, params) {
    var board = getBoardFor(role, params && params.boardId);
    var cell = board && board.cells && board.cells.get(Number(params.index));
    var cost = TABLES.Config && TABLES.Config.cookStopCost;
    if (cost && cost.Diamond) role.diamond = Math.max(0, (role.diamond || 0) - Number(cost.Diamond));
    if (cell) {
      var order = ensureCellOrder(cell);
      order.id = 0; order.orderId = 0; order.state = 0; order.endTime = 0;
      order.elements = new Map();
      cell.hiddenPocket = [];
    }
    console.log('[mock-cook] 停止烹饪 idx=' + (params && params.index) + ' 扣钻' + (cost && cost.Diamond || 0));
    scheduleSave();
  }
  // 收菜(单个/批量):请求 cells=客户端权威产出;服务器确认=清灶具订单+产出落活体棋盘
  function applyCookCollect(role, params) {
    var board = getBoardFor(role, params && params.boardId);
    if (!board) return;
    var idx = Number(params.index);
    var cell = board.cells && board.cells.get(idx);
    if (cell) {
      var order = ensureCellOrder(cell);
      order.id = 0; order.orderId = 0; order.state = 0; order.endTime = 0;
      order.elements = new Map();
      cell.hiddenPocket = [];
    }
    var produced = params.cells;
    if (Array.isArray(produced)) {
      for (var i = 0; i < produced.length; i++) {
        var pc = produced[i];
        if (!pc || pc.elementId === undefined || pc.index === undefined) continue;
        if (!board.cells.has(pc.index) || !board.cells.get(pc.index).elementId) {
          // 空格落子(与 ns/rs 形状对齐的最小 cell)
          board.cells.set(pc.index, {
            uUID: pc.index + 1, seed: 0, index: pc.index, elementId: pc.elementId,
            state: 0, productType: pc.productType || 0, bubbleEnd: 0, deteriorateEnd: 0,
            openEnd: 0, pauseTime: 0, endTime: 0, processTime: 0, skills: new Map(),
            order: { id: 0, orderId: 0, demand: new Map(), elements: new Map(), unlock: [], rewards: new Map(), rewarded: false, state: 0, endTime: 0, pauseTime: 0 },
            orderBegin: [], hp: new Map(), recovery: new Map(), productCount: 0,
            autoProductCount: 0, extra: new Map(), hiddenPocket: [], cost: pc.cost || 0
          });
        }
      }
    }
    console.log('[mock-cook] 收菜 idx=' + idx + ' 产出x' + (Array.isArray(produced) ? produced.length : 0));
    scheduleSave();
  }

  // ===== 阶段二：常规背包与发射器仓库业务支持 =====
  function ensureRoleLauncherBag(role) {
    if (!role) return;
    if (!role.launcherBag) {
      role.launcherBag = { id: 0, handbook: new Map(), items: new Map() };
    }
    if (!(role.launcherBag.handbook instanceof Map)) role.launcherBag.handbook = new Map();
    if (!(role.launcherBag.items instanceof Map)) role.launcherBag.items = new Map();
  }

  function applyBagBuy(role, params) {
    var b = getBoardFor(role);
    if (!b || !b.bag) return { ok: false, error: '背包未就绪' };
    var currentSize = Number(b.bag.size) || 8;
    var nextId = currentSize + 1;
    var bt = TABLES.Bag && TABLES.Bag.normal;
    var conf = bt && (bt[nextId] || bt[String(nextId)]);
    if (!conf && window.config && window.config.Bag) {
      if (typeof window.config.Bag.getById === 'function') conf = window.config.Bag.getById(nextId);
      if (!conf && window.config.Bag.config && window.config.Bag.config.normal) {
        conf = window.config.Bag.config.normal[nextId] || window.config.Bag.config.normal[String(nextId)];
      }
    }
    if (!conf && nextId <= 60) {
      conf = { unlock: { Diamond: Math.min(1000, 5 * Math.max(1, nextId - 8)) } };
    }
    if (!conf) {
      return { ok: false, error: '已达背包上限' };
    }
    var costDiamond = (conf.unlock && Number(conf.unlock.Diamond)) || 0;
    var costCoin = (conf.unlock && Number(conf.unlock.Coin)) || 0;
    if (costDiamond > 0 && (role.diamond || 0) < costDiamond) {
      return { ok: false, error: '钻石不足' };
    }
    if (costCoin > 0 && (role.coin || 0) < costCoin) {
      return { ok: false, error: '金币不足' };
    }
    if (costDiamond > 0) role.diamond -= costDiamond;
    if (costCoin > 0) role.coin -= costCoin;
    b.bag.size = nextId;
    console.log('[mock-bag] 购买背包格子: size -> ' + nextId + ' (花费钻:' + costDiamond + ' 币:' + costCoin + ')');
    return { ok: true, newSize: nextId };
  }

  function applyCellToBag(role, params) {
    syncRuntimeBoardsToRole(role);
    var b = getBoardFor(role);
    if (!b || !b.bag) return { ok: false, error: '背包未就绪' };
    if (!(b.bag.items instanceof Map)) b.bag.items = new Map();
    var capacity = (Number(b.bag.size) || 8) + (Number(b.bag.extSize) || 0);
    if (b.bag.items.size >= capacity) {
      return { ok: false, error: '背包已满' };
    }
    var idx = Number(params && params.index);
    var cell = b.cells && b.cells.get(idx);
    if (cell) b.cells.delete(idx);

    var targetElem = Number(params && params.elementId) || (cell && cell.elementId) || 0;
    if (targetElem > 0) {
      b.incrementId = (Number(b.incrementId) || 100) + 1;
      var newBagId = b.incrementId;
      var bagCell = (cell && cell.elementId) ? Object.assign({}, cell, { elementId: targetElem, index: -1 }) : { elementId: targetElem, state: 0, index: -1, hp: 0 };
      b.bag.items.set(newBagId, bagCell);
      console.log('[mock-bag] 存入背包: elementId=' + bagCell.elementId + ' from idx=' + idx + ' -> bagId=' + newBagId);
      return { ok: true, bagId: newBagId, cell: bagCell };
    } else {
      console.warn('[mock-bag] 未解析到有效 elementId，避免塞入0值废对象，由客户端活体状态主导');
      return { ok: true, bagId: 0, cell: null };
    }
  }

  function applyCellBagPut(role, params) {
    syncRuntimeBoardsToRole(role);
    var b = getBoardFor(role);
    if (!b || !b.bag) return { ok: false, error: '背包未就绪' };
    if (!(b.bag.items instanceof Map)) b.bag.items = new Map();
    var bagId = Number(params && params.bagId);
    var toIndex = Number(params && params.toIndex);

    var cell = b.bag.items.get(bagId);
    var foundBagId = bagId;

    // 智能容错：如果 key 对不上（例如客户端提前删了或自增 ID 偏移）
    if (!cell && b.bag.items.size > 0) {
      var it = b.bag.items.entries().next();
      if (!it.done) {
        foundBagId = it.value[0];
        cell = it.value[1];
        console.warn('[mock-bag] bagId=' + bagId + ' 未精确命中，自动匹配现有项 key=' + foundBagId);
      }
    }

    if (cell) {
      b.bag.items.delete(foundBagId);
    } else {
      console.warn('[mock-bag] 背包已空或客户端提前取出，保持棋盘现存项');
      var existing = b.cells && b.cells.get(toIndex);
      cell = existing || { elementId: 0, state: 0, hp: 0, index: toIndex };
    }

    b.incrementId = (Number(b.incrementId) || 100) + 1;
    var boardCell = Object.assign({}, cell, {
      index: toIndex,
      uUID: b.incrementId,
      seed: Math.floor(Math.random() * 100000) + 1
    });
    b.cells.set(toIndex, boardCell);
    console.log('[mock-bag] 取回棋盘成功: elementId=' + boardCell.elementId + ' bagId=' + bagId + ' -> toIndex=' + toIndex + ' uUID=' + boardCell.uUID);
    return { ok: true, cell: boardCell };
  }

  // ===== 阶段三：相册系统 (ImgBox) 与 周任务体系 (WeekTask) 核心业务 =====

  function ensureRoleBoxes(role) {
    if (!role) return;
    if (!role.boxes) {
      role.boxes = {
        id: 0,
        img: new Map([[1, { count: 1 }]]),
        boxes: new Map([[1, { count: 1 }]]),
        uniform: new Map([[1, { count: 1 }]]),
        pet: new Map([[1, { count: 1, name: '肥鹅宝贝' }]]),
        badge: new Map([[1, { count: 1 }]])
      };
    }
    if (!(role.boxes.img instanceof Map)) role.boxes.img = new Map([[1, { count: 1 }]]);
    if (!(role.boxes.boxes instanceof Map)) role.boxes.boxes = new Map([[1, { count: 1 }]]);
    if (!(role.boxes.uniform instanceof Map)) role.boxes.uniform = new Map([[1, { count: 1 }]]);
    if (!(role.boxes.pet instanceof Map)) role.boxes.pet = new Map([[1, { count: 1, name: '肥鹅宝贝' }]]);
    if (!(role.boxes.badge instanceof Map)) role.boxes.badge = new Map([[1, { count: 1 }]]);
  }

  function getWeekStartSec(now) {
    var d = new Date(now || Date.now());
    var day = d.getDay();
    if (day === 0) day = 7;
    var dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    var diff = (day - 1) * 86400 * 1000;
    return Math.floor((dStart.getTime() - diff) / 1000);
  }

  function createGlobalActivityItem(data) {
    var item = Object.assign({
      id: 101,
      typeId: 'weekTask',
      content: 'wt1',
      beginAt: 0,
      endAt: 0,
      prepareEndAt: 0,
      priceDeadAt: 0
    }, data);
    item.isBegin = function () { var now = (window.d3 ? window.d3.serverTime : Date.now()) / 1000; return now >= this.beginAt; };
    item.isEnd = function () { var now = (window.d3 ? window.d3.serverTime : Date.now()) / 1000; return this.endAt < now; };
    item.isPriceEnd = function () { var now = (window.d3 ? window.d3.serverTime : Date.now()) / 1000; return this.priceDeadAt < now; };
    item.isOnPrepare = function () { return false; };
    item.isPrepareEnd = function () { return true; };
    item.is = function (e) { return typeof e === 'number' ? this.id === e : this.typeId === e; };
    return item;
  }

  function ensureRoleWeekTask(role) {
    if (!role) return;
    var wStart = getWeekStartSec();
    var wEnd = wStart + 7 * 86400;

    // 1. 注册全局活动 weekTask (aid: 101)
    if (!role.globalActivity) role.globalActivity = new Map();
    if (!(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    role.globalActivity.set(101, createGlobalActivityItem({
      id: 101,
      typeId: 'weekTask',
      content: 'wt1',
      beginAt: wStart,
      endAt: wEnd,
      prepareEndAt: wStart,
      priceDeadAt: wEnd + 86400 * 3
    }));

    // 2. 初始化周任务数据结构
    if (!role.weekTask) role.weekTask = new Map();
    if (!(role.weekTask instanceof Map)) role.weekTask = new Map();
    var wt = role.weekTask.get(101);
    if (!wt || wt.startTime !== wStart) {
      wt = {
        startTime: wStart,
        tierId: 1,
        taskProgress: new Map([
          [4, 1], // Login: 累计登录1天
          [0, 0], // Merge: 合成次数
          [6, 0], // CompleteOrder: 订单数
          [3, 0], // CollectCoin: 收集金币数
          [5, 0], // CompleteDrawer: 抽屉数
          [1, 0]  // CostDiamond: 消耗钻石数
        ]),
        taskRewarded: new Map(),
        progressScore: 0,
        progressRewarded: new Map(),
        lastWeekTaskRewards: []
      };
      role.weekTask.set(101, wt);
    }
  }

  function trackWeekTaskProgress(role, taskType, delta) {
    if (!role) return;
    ensureRoleWeekTask(role);
    var wt = role.weekTask && role.weekTask.get(101);
    if (!wt) return;
    if (!(wt.taskProgress instanceof Map)) wt.taskProgress = new Map();
    var cur = Number(wt.taskProgress.get(taskType)) || 0;
    wt.taskProgress.set(taskType, cur + (delta || 1));
  }

  var FALLBACK_WEEK_TASKS = {
    1101: { id: 1101, taskType: 4, count: 1, rewards: { weekPoint: 10, SpeedUpCoupon: 15 } },
    1102: { id: 1102, taskType: 0, count: 50, rewards: { weekPoint: 20, Energy: 15 } },
    1103: { id: 1103, taskType: 5, count: 1, rewards: { weekPoint: 20, SpeedUpCoupon: 15 } },
    1104: { id: 1104, taskType: 6, count: 10, rewards: { 5004001: 1, weekPoint: 15 } },
    1105: { id: 1105, taskType: 3, count: 2000, rewards: { 5004002: 1, weekPoint: 20 } },
    1201: { id: 1201, taskType: 4, count: 2, rewards: { weekPoint: 10, SpeedUpCoupon: 15 } },
    1202: { id: 1202, taskType: 0, count: 100, rewards: { weekPoint: 20, Energy: 20 } },
    1203: { id: 1203, taskType: 1, count: 30, rewards: { weekPoint: 25, SpeedUpCoupon: 20 } },
    1204: { id: 1204, taskType: 6, count: 15, rewards: { 5004001: 1, weekPoint: 20 } },
    1205: { id: 1205, taskType: 3, count: 3000, rewards: { 5004002: 1, weekPoint: 20 } }
  };

  var FALLBACK_WEEK_PROGRESS = {
    101: { id: 101, points: 100, rewards: { Energy: 30 } },
    102: { id: 102, points: 250, rewards: { Film3: 1 } },
    103: { id: 103, points: 585, rewards: { Energy: 50 } },
    104: { id: 104, points: 825, rewards: { Film4: 1 } },
    105: { id: 105, points: 1055, rewards: { 5001001: 1, Film5: 1, Diamond: 15 } }
  };

  function applyWeekTaskClaim(role, params) {
    ensureRoleWeekTask(role);
    var taskId = Number(params && params.taskId);
    var wt = role.weekTask && role.weekTask.get(101);
    if (!wt) return { ok: false, error: '周任务数据未就绪' };
    if (!(wt.taskRewarded instanceof Map)) wt.taskRewarded = new Map();
    if (wt.taskRewarded.get(taskId)) return { ok: false, error: '该任务奖励已领取' };

    var conf = null;
    if (TABLES.weekTask && TABLES.weekTask['1'] && TABLES.weekTask['1'][taskId]) {
      conf = TABLES.weekTask['1'][taskId];
    } else {
      conf = FALLBACK_WEEK_TASKS[taskId];
    }
    if (!conf) conf = { rewards: { weekPoint: 15, Coin: 500 } };

    var rewards = [];
    if (conf.rewards) {
      for (var rk in conf.rewards) {
        var rv = Number(conf.rewards[rk]) || 0;
        if (rk === 'weekPoint') {
          wt.progressScore = (wt.progressScore || 0) + rv;
        } else {
          var single = {};
          single[rk] = rv;
          var parsed = parseRewardMap(single);
          if (parsed && parsed.length) rewards.push.apply(rewards, parsed);
        }
      }
    }

    wt.taskRewarded.set(taskId, true);
    if (rewards.length) grantChannelElements(role, rewards, 'weekTask');
    console.log('[mock-weektask] 成功领取任务 taskId=' + taskId + ' 奖励:', rewards, '当前周积分:' + wt.progressScore);
    return { ok: true, rewards: rewards };
  }

  function applyWeekProgressClaim(role, params) {
    ensureRoleWeekTask(role);
    var progressId = Number(params && params.progress);
    var wt = role.weekTask && role.weekTask.get(101);
    if (!wt) return { ok: false, error: '周任务数据未就绪' };
    if (!(wt.progressRewarded instanceof Map)) wt.progressRewarded = new Map();
    if (wt.progressRewarded.get(progressId)) return { ok: false, error: '该周宝箱已领取' };

    var conf = null;
    if (TABLES.weekProgressReward && TABLES.weekProgressReward['1'] && TABLES.weekProgressReward['1'][progressId]) {
      conf = TABLES.weekProgressReward['1'][progressId];
    } else {
      conf = FALLBACK_WEEK_PROGRESS[progressId];
    }
    if (!conf) conf = { rewards: { Energy: 50, Diamond: 10 } };

    var rewards = parseRewardMap(conf.rewards);
    wt.progressRewarded.set(progressId, true);
    if (rewards.length) grantChannelElements(role, rewards, 'weekProgress');
    console.log('[mock-weektask] 成功领取周宝箱 progressId=' + progressId + ' 奖励:', rewards);
    return { ok: true, rewards: rewards };
  }

  // ===== 阶段四：系统信箱与福利体系核心业务支持 =====

  function ensureRoleMails(role) {
    if (!role) return;
    if (!Array.isArray(role.mails)) role.mails = [];
    if (role.mails.length === 0) {
      role.mails = [
        {
          id: 10001,
          title: "欢迎来到肥鹅美食街！",
          from: "肥鹅后勤部",
          content: JSON.stringify({ isnotice: "0", desc: "亲爱的店长，欢迎来到肥鹅美食街！这是为您准备的开店启动物资，请查收！" }),
          createAt: Math.floor(Date.now() / 1000) - 3600,
          expireAt: Math.floor(Date.now() / 1000) + 86400 * 30,
          state: 1, // yr.newMail = 1
          haveAttachments: true,
          rewards: [
            { itemType: 1, itemId: 0, value: 1888 }, // 1888 金币
            { itemType: 4, itemId: 0, value: 60 },   // 60 体力
            { itemType: 2, itemId: 0, value: 50 }    // 50 钻石
          ]
        },
        {
          id: 10002,
          title: "店长专属进阶补给",
          from: "运营鹅仔",
          content: JSON.stringify({ isnotice: "0", desc: "特聘店长专属福利，助您早日修缮美食街，走上致富之路！" }),
          createAt: Math.floor(Date.now() / 1000) - 1800,
          expireAt: Math.floor(Date.now() / 1000) + 86400 * 30,
          state: 1, // yr.newMail = 1
          haveAttachments: true,
          rewards: [
            { itemType: 5, itemId: 0, value: 20 },   // 20 生产加速券
            { itemType: 4, itemId: 0, value: 50 },   // 50 体力
            { itemType: 7, itemId: 5001001, value: 1 } // 进阶宝箱
          ]
        }
      ];
    }
    var unread = 0;
    role.mails.forEach(function (m) {
      if (m && Number(m.state) < 3) unread++;
    });
    role.mailNewCount = unread;
    mergeCloudMails(role);
  }

  // ===== 阶段五：通行证系统与竞赛/排行榜核心业务支持 =====

  function ensureRolePass(role) {
    if (!role) return;
    // 遵循原版配置表 PassAct: 完成第 12 个抽屉(FinishDrawer12)才解锁通行证与VIP系统
    var b1 = role.boards && role.boards.get(1);
    if (!b1 || (b1.orderDrawerEndId || 0) < 12) return;
    var nowSec = Math.floor(Date.now() / 1000);
    if (!role.globalActivity) role.globalActivity = new Map();
    if (!(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var act = role.globalActivity.get(10001);
    if (!act) {
      act = createGlobalActivityItem({
        id: 10001,
        typeId: 'pass',
        content: '1',
        beginAt: nowSec - 86400 * 2,
        endAt: nowSec + 86400 * 28,
        prepareEndAt: nowSec - 86400 * 2,
        priceDeadAt: nowSec + 86400 * 28
      });
      role.globalActivity.set(10001, act);
    }

    if (!role.pass) role.pass = new Map();
    if (!(role.pass instanceof Map)) role.pass = new Map();
    var pData = role.pass.get(10001);

    if (!pData) {
      pData = {
        status: 0, // 0: Free, 1: VIP, 2: SVIP
        passPoint: 0,
        rewarded: new Map([
          [0, []],
          [1, []],
          [2, []]
        ]),
        eventId: '1'
      };
      role.pass.set(10001, pData);
    }
  }

  function addPassPoints(role, count) {
    if (!role || !count) return;
    ensureRolePass(role);
    var pData = role.pass && role.pass.get(10001);
    if (pData) {
      pData.passPoint = (pData.passPoint || 0) + Number(count);
      console.log('[mock-pass] 增加通行证积分 +' + count + ', 当前积分: ' + pData.passPoint);
    }
  }

  function applyPassReward(role, params) {
    if (!role) return { ok: false, error: 'no role' };
    ensureRolePass(role);
    var aid = Number(params && params.aid) || 10001;
    var pData = role.pass && role.pass.get(aid);
    if (!pData) return { ok: false, error: 'pass data not found' };

    var idx = Number(params && params.idx);
    var rewardType = Number(params && params.rewardType) || 0;

    var taskList = [];
    var cfgTasks = TABLES.PassTask && (TABLES.PassTask['1'] || TABLES.PassTask[pData.eventId]);
    if (cfgTasks) {
      taskList = Object.values(cfgTasks).sort(function (a, b) { return a.point - b.point; });
    }

    var allRewards = [];
    if (!(pData.rewarded instanceof Map)) pData.rewarded = new Map();

    function claimSingle(targetIdx, track) {
      if (targetIdx < 0 || targetIdx >= taskList.length) return;
      var task = taskList[targetIdx];
      if (!task) return;
      if (pData.passPoint < task.point) return;
      if (pData.status < track) return;

      var trackList = pData.rewarded.get(track);
      if (!trackList) {
        trackList = [];
        pData.rewarded.set(track, trackList);
      }
      if (trackList.includes(targetIdx)) return;

      var rwObj = track === 0 ? task.reward1 : track === 1 ? task.reward2 : task.reward3;
      var rwItems = parseRewardMap(rwObj);
      rwItems.forEach(function (it) { allRewards.push(it); });
      trackList.push(targetIdx);
    }

    if (idx === -1) {
      var maxTrack = Math.min(2, pData.status);
      for (var trk = 0; trk <= maxTrack; trk++) {
        for (var tIdx = 0; tIdx < taskList.length; tIdx++) {
          claimSingle(tIdx, trk);
        }
      }
    } else {
      claimSingle(idx, rewardType);
    }

    if (allRewards.length > 0) {
      grantCurrency(role, allRewards);
      grantChannelElements(role, allRewards, 'pass_reward');
      console.log('[mock-pass] 通行证发放奖励共 ' + allRewards.length + ' 堆物品');
    }

    return { ok: true, rewards: allRewards };
  }

  function applyPBPassReward(role, params) {
    if (!role) return { ok: false, error: 'no role' };
    var aid = Number(params && params.aid) || 0;
    var rewardId = Number(params && params.rewardId) || 0;
    var rewardType = Number(params && params.rewardType) || 1; // 1: Free, 2: VIP

    var targetPBPass = null;
    if (role.chess7 && typeof role.chess7.forEach === 'function') {
      role.chess7.forEach(function (val, key) {
        if (!targetPBPass && val && val.progressBoardPass) {
          if (!aid || val.progressBoardPass.passAid === aid || Number(key) === aid) {
            targetPBPass = val.progressBoardPass;
          }
        }
      });
    }

    if (!targetPBPass && role.chess7 && role.chess7.size > 0) {
      var firstChess = role.chess7.values().next().value;
      if (firstChess && firstChess.progressBoardPass) targetPBPass = firstChess.progressBoardPass;
    }

    // 检查 VIP 权限
    if (rewardType === 2 && (!targetPBPass || !targetPBPass.vipPurchased)) {
      return { ok: false, error: '未开通高级会员特权' };
    }

    // 记录已领取标记
    if (targetPBPass) {
      if (rewardType === 1) {
        if (!targetPBPass.freeRewarded) targetPBPass.freeRewarded = new Map();
        if (targetPBPass.freeRewarded instanceof Map) targetPBPass.freeRewarded.set(rewardId, true);
        else targetPBPass.freeRewarded[rewardId] = true;
      } else {
        if (!targetPBPass.vipRewarded) targetPBPass.vipRewarded = new Map();
        if (targetPBPass.vipRewarded instanceof Map) targetPBPass.vipRewarded.set(rewardId, true);
        else targetPBPass.vipRewarded[rewardId] = true;
      }
    }

    // 查找配置表
    var rewardRow = null;
    var pTable = TABLES.PBPassReward || (window.config && window.config.PBPassReward && window.config.PBPassReward.sheetList);
    if (pTable) {
      if (typeof pTable.forEach === 'function') {
        pTable.forEach(function (sheet) {
          if (!rewardRow && sheet) {
            if (sheet instanceof Map) rewardRow = sheet.get(rewardId) || sheet.get(String(rewardId));
            else if (sheet[rewardId]) rewardRow = sheet[rewardId];
          }
        });
      } else {
        Object.keys(pTable).forEach(function (sheetKey) {
          var sheet = pTable[sheetKey];
          if (!rewardRow && sheet) {
            if (sheet[rewardId]) rewardRow = sheet[rewardId];
          }
        });
      }
    }

    var rawRewards = null;
    if (rewardRow) {
      rawRewards = (rewardType === 2 ? rewardRow.vipReward : rewardRow.freeReward);
    }
    var granted = [];
    if (rawRewards) {
      granted = parseRewardMap(rawRewards);
    }
    if (granted.length === 0) {
      granted.push({ itemType: (rewardType === 2 ? 2 : 4), itemId: 0, value: (rewardType === 2 ? 30 : 50) });
    }

    grantCurrency(role, granted);
    grantChannelElements(role, granted, 'pbpass_reward');
    console.log('[mock-pbpass] 成功领取棋盘通行证奖励 rewardId:', rewardId, 'type:', rewardType === 2 ? 'VIP' : 'Free', 'rewards:', granted);

    return { ok: true, rewards: granted };
  }

  function ensureRoleEnergyPass(role) {
    if (!role) return;
    var nowSec = Math.floor(Date.now() / 1000);
    if (!role.globalActivity) role.globalActivity = new Map();
    if (!(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var act = role.globalActivity.get(20001);
    if (!act) {
      act = createGlobalActivityItem({
        id: 20001,
        typeId: 'energyPass',
        content: 'energypass1',
        beginAt: nowSec - 86400 * 2,
        endAt: nowSec + 86400 * 28,
        prepareEndAt: nowSec - 86400 * 2,
        priceDeadAt: nowSec + 86400 * 28
      });
      role.globalActivity.set(20001, act);
    }

    if (!role.energyPass) role.energyPass = new Map();
    if (!(role.energyPass instanceof Map)) role.energyPass = new Map();
    var epData = role.energyPass.get(20001);
    if (!epData) {
      epData = {
        id: 991001,
        count: 0,
        mapPassReward: new Map(),
        point: 0,
        group: '1',
        isVip: true
      };
      role.energyPass.set(20001, epData);
    } else {
      epData.id = 991001; // 必须匹配 energepassInfo.goodsIds，否则窗口打不开报 discount 错误
    }
  }

  function addEnergyPassPoints(role, count) {
    if (!role || !count) return;
    ensureRoleEnergyPass(role);
    var epData = role.energyPass && role.energyPass.get(20001);
    if (epData) {
      epData.point = (epData.point || 0) + Number(count);
      console.log('[mock-energypass] 累计能量挑战积分 +' + count + ', 当前积分: ' + epData.point);
    }
  }

  function applyEnergyPassReward(role, params, isAll) {
    if (!role) return { ok: false, error: 'no role' };
    ensureRoleEnergyPass(role);
    var aid = Number(params && params.aid) || 20001;
    var epData = role.energyPass && role.energyPass.get(aid);
    if (!epData) return { ok: false, error: 'energypass data not found' };

    var info = TABLES.energepassInfo && (Object.values(TABLES.energepassInfo)[0] || TABLES.energepassInfo[1]);
    if (!info) return { ok: false, error: 'energypass config not found' };

    var stickerpro = info.stickerpro || [];
    var energepro = info.energepro || [];

    var allRewards = [];
    if (!(epData.mapPassReward instanceof Map)) epData.mapPassReward = new Map();

    function claimStage(i) {
      if (i < 0 || i >= stickerpro.length) return;
      if (epData.point < stickerpro[i]) return;
      if (epData.mapPassReward.get(i)) return;

      var rwObj = energepro[i];
      var rwItems = parseRewardMap(rwObj);
      rwItems.forEach(function (it) { allRewards.push(it); });
      epData.mapPassReward.set(i, 1);
    }

    if (isAll) {
      for (var s = 0; s < stickerpro.length; s++) {
        claimStage(s);
      }
    } else {
      var targetIdx = Number(params && params.idx);
      claimStage(targetIdx);
    }

    if (allRewards.length > 0) {
      grantCurrency(role, allRewards);
      grantChannelElements(role, allRewards, 'energypass_reward');
      console.log('[mock-energypass] 能量挑战发放奖励共 ' + allRewards.length + ' 堆物品');
    }

    return { ok: true, rewards: allRewards };
  }

  function ensureRoleWeightRace(role) {
    if (!role) return;
    var nowSec = Math.floor(Date.now() / 1000);
    if (!role.globalActivity) role.globalActivity = new Map();
    if (!(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    if (!role.globalActivity.has(30001)) {
      role.globalActivity.set(30001, createGlobalActivityItem({
        id: 30001,
        typeId: 'weightRace',
        content: 'race1',
        beginAt: nowSec - 86400 * 2,
        endAt: nowSec + 86400 * 28,
        prepareEndAt: nowSec - 86400 * 2,
        priceDeadAt: nowSec + 86400 * 28
      }));
    }

    if (!role.weightRace) role.weightRace = new Map();
    if (!(role.weightRace instanceof Map)) role.weightRace = new Map();
    var wr = role.weightRace.get(30001);
    var validRobots = [
      {
        id: 1001,
        name: "小鹅领跑员",
        icon: "",
        iconFrame: 0,
        wearBadgeId: 0,
        score: [
          { seconds: 0, score: 0 },
          { seconds: 3600, score: 20 },
          { seconds: 7200, score: 40 }
        ],
        track: 0,
        playerConfigId: "robot1"
      },
      {
        id: 1002,
        name: "肥鹅吃货",
        icon: "",
        iconFrame: 0,
        wearBadgeId: 0,
        score: [
          { seconds: 0, score: 0 },
          { seconds: 3600, score: 15 },
          { seconds: 7200, score: 30 }
        ],
        track: 1,
        playerConfigId: "robot2"
      }
    ];

    if (!wr || !Array.isArray(wr.playerDatas) || !wr.playerDatas[0] || !Array.isArray(wr.playerDatas[0].score)) {
      wr = {
        curRaceId: 1,
        completeRaceNum: 0,
        state: 1,
        point: 50,
        entryTime: nowSec - 3600,
        segmentId: "1",
        playerDatas: validRobots,
        myScore: { seconds: 0, score: 50 },
        history: []
      };
      role.weightRace.set(30001, wr);
    } else {
      // 兼容旧坏档中的非数组 score
      wr.playerDatas = validRobots;
      if (!wr.myScore || typeof wr.myScore.score !== 'number') {
        wr.myScore = { seconds: 0, score: 50 };
      }
    }
  }

  function ensureRoleGymSprint(role) {
    if (!role) return;
    var nowSec = Math.floor(Date.now() / 1000);
    if (!role.globalActivity) role.globalActivity = new Map();
    if (!(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    if (!role.globalActivity.has(40001)) {
      role.globalActivity.set(40001, createGlobalActivityItem({
        id: 40001,
        typeId: 'gymSprint',
        content: 'gymSprint1',
        beginAt: nowSec - 86400 * 2,
        endAt: nowSec + 86400 * 28,
        prepareEndAt: nowSec - 86400 * 2,
        priceDeadAt: nowSec + 86400 * 28
      }));
    }

    if (!role.gymSprint) role.gymSprint = new Map();
    if (!(role.gymSprint instanceof Map)) role.gymSprint = new Map();
    var gs = role.gymSprint.get(40001);
    if (!gs) {
      gs = {
        point: 100,
        mergeCount: 20,
        taskId: 1,
        tierId: "gymSprint1_t1"
      };
      role.gymSprint.set(40001, gs);
    } else {
      gs.tierId = "gymSprint1_t1"; // 必须匹配 gymSprintTask 的 sheet 名，否则 sheetList 为 undefined
    }
  }

  // ===== 全量扩展：第一部分（核心自动触发与惊喜掉落）与第二部分（副棋盘与微型玩法） =====

  // 1.1 SurpriseBox (惊喜盒子)
  function ensureRoleSurpriseBox(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 50001;
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'surpriseBox',
        content: 'surpriseBox1'
      }));
    }
    if (!role.surpriseBox || !(role.surpriseBox instanceof Map)) role.surpriseBox = new Map();
    if (!role.surpriseBox.has(aid)) {
      role.surpriseBox.set(aid, {
        episodeId: 1,
        lastTriggerAt: Math.floor(Date.now() / 1000) - 100,
        triggeredDrawerIds: [],
        pendingOrderRewards: []
      });
    }
  }

  // 1.2 DrawerRush (抽屉冲刺)
  function ensureRoleDrawerRush(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 60001;
    var now = Math.floor(Date.now() / 1000);
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'drawerRush',
        content: 'drawerRush1'
      }));
    }
    if (!role.drawerRush || !(role.drawerRush instanceof Map)) role.drawerRush = new Map();
    if (!role.drawerRush.has(aid)) {
      role.drawerRush.set(aid, {
        triggered: false,
        currentDrawerId: 0,
        windowStartAt: now,
        windowEndAt: now + 3600,
        rewards: [
          { itemType: 'Energy', value: 15 },
          { itemType: '5004001', value: 1 }
        ]
      });
    }
  }

  // 1.3 Clover (四叶草收集)
  function ensureRoleClover(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 70001;
    var now = Math.floor(Date.now() / 1000);
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'clover',
        content: 'clover1'
      }));
    }
    if (!role.clover || !(role.clover instanceof Map)) role.clover = new Map();
    if (!role.clover.has(aid)) {
      role.clover.set(aid, {
        episodeId: 1,
        episodeStartAt: now - 300,
        episodeEndAt: now + 86400 * 3,
        progress: 0,
        rewardClaimed: false,
        currentOrderId: 0
      });
    }
  }

  // 1.4 SmileBuff (火热做菜模式)
  function ensureRoleSmileBuff(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 80001;
    var now = Math.floor(Date.now() / 1000);
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'smileBuff',
        content: 'smileBuff1'
      }));
    }
    if (!role.smileBuff || !(role.smileBuff instanceof Map)) role.smileBuff = new Map();
    if (!role.smileBuff.has(aid)) {
      role.smileBuff.set(aid, {
        currentLevel: 1,
        score: 0,
        targetScore: 5,
        roundEndAt: now + 7200
      });
    }
  }

  // 2.1 Chess7 (ProgressBoard 7日副棋盘)
  function ensureRoleChess7Board(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 90001;
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'chessBoard7',
        content: '1'
      }));
    }
    if (!role.chess7 || !(role.chess7 instanceof Map)) role.chess7 = new Map();
    var c7 = role.chess7.get(aid);
    if (!c7) {
      c7 = {
        progressBoardKey: 10,
        unlockedFogs: [1],
        claimedElements: [],
        claimedSeries: [],
        isWin: false,
        winRewarded: false,
        progressBoardPass: {
          vipPurchased: false,
          point: 0,
          claimedRewards: []
        }
      };
      role.chess7.set(aid, c7);
    }
  }

  // 2.2 DigTreasure (铁锹挖宝大冒险)
  function ensureRoleDigTreasure(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 91001;
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'diggame',
        content: 'diggame1'
      }));
    }
    if (!role.diggame || !(role.diggame instanceof Map)) role.diggame = new Map();
    if (!role.diggame.has(aid)) {
      var board = [
        [0, 0, 0, 12, 0],
        [1, 0, 0, 12, 0],
        [2, 0, 0, 12, 0],
        [0, 1, 0, 12, 1],
        [1, 1, 0, 12, 1],
        [2, 1, 0, 12, 1],
        [0, 2, 0, 12, 2],
        [1, 2, 0, 12, 2],
        [2, 2, 0, 12, 2]
      ];
      role.diggame.set(aid, {
        shovelCount: 20,
        orderID: 101,
        level: 1,
        board: board,
        rewardClaimed: false
      });
    }
  }

  // 2.3 BirdToFly (小鸟飞飞)
  function ensureRoleBirdToFly(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 92001;
    var now = Math.floor(Date.now() / 1000);
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'birdToFly',
        content: 'birdToFly1'
      }));
    }
    if (!role.birdToFly || !(role.birdToFly instanceof Map)) role.birdToFly = new Map();
    if (!role.birdToFly.has(aid)) {
      role.birdToFly.set(aid, {
        point: 0,
        stage: 1,
        started: true,
        claimedStage: 0,
        expiredMask: 0,
        stageEndAt: now + 1200
      });
    }
  }

  // 2.4 BumperCar (碰碰车)
  function ensureRoleBumperCar(role) {
    if (!role) return;
    if (!role.globalActivity || !(role.globalActivity instanceof Map)) role.globalActivity = new Map();
    var aid = 93001;
    var now = Math.floor(Date.now() / 1000);
    if (!role.globalActivity.has(aid)) {
      role.globalActivity.set(aid, createGlobalActivityItem({
        id: aid,
        typeId: 'bumperCar',
        content: 'bumper1'
      }));
    }
    if (!role.bumperCar || !(role.bumperCar instanceof Map)) role.bumperCar = new Map();
    if (!role.bumperCar.has(aid)) {
      role.bumperCar.set(aid, {
        curRaceId: 1,
        entryTime: now,
        progress: 0,
        point: 0,
        startCount: 1,
        completeRaceNum: 0,
        targetScore: 50,
        playerDatas: [
          { id: 1, name: '竞争鹅1', score: 20 },
          { id: 2, name: '竞争鹅2', score: 35 }
        ]
      });
    }
  }

  function ensureAllExtendedActivities(role) {
    if (!role) return;
    ensureRoleSurpriseBox(role);
    ensureRoleDrawerRush(role);
    ensureRoleClover(role);
    ensureRoleSmileBuff(role);
    ensureRoleChess7Board(role);
    ensureRoleDigTreasure(role);
    ensureRoleBirdToFly(role);
    ensureRoleBumperCar(role);
  }


  function applyCellMove(role, params) {
    syncRuntimeBoardsToRole(role);
    var b = getBoardFor(role, params && params.boardId);
    if (!b || !(b.cells instanceof Map)) return { ok: false, error: '棋盘未就绪' };

    var fromIdx = Number(params && params.index);
    var toIdx = Number(params && params.toIndex);
    var moveType = Number(params && params.moveType) || 1;

    console.log('[mock-move] 移动/合成请求: moveType=' + moveType + ' from=' + fromIdx + ' -> to=' + toIdx);

    if (moveType === 1) {
      // 普通移动
      var fromCell = b.cells.get(fromIdx);
      if (fromCell) {
        b.cells.delete(fromIdx);
        fromCell.index = toIdx;
        b.cells.set(toIdx, fromCell);
      }
    } else if (moveType === 2) {
      // 合成
      var sourceCell = b.cells.get(fromIdx);
      var targetCell = b.cells.get(toIdx);

      // 源格子在合成后必定被消耗清除
      b.cells.delete(fromIdx);

      // 计算合成后新元素的 elementId
      var targetElemId = (targetCell && Number(targetCell.elementId)) || (sourceCell && Number(sourceCell.elementId)) || 0;
      var newElemId = 0;

      // 1. 若 params.cells 显式包含了 toIdx 的新元素，直接采纳
      if (Array.isArray(params && params.cells)) {
        for (var i = 0; i < params.cells.length; i++) {
          var c = params.cells[i];
          if (c && Number(c.index) === toIdx && Number(c.elementId) > 0) {
            newElemId = Number(c.elementId);
            break;
          }
        }
      }

      // 2. 若未显式给出，查配置表中的 mergeElementId
      if (!newElemId && targetElemId > 0 && TABLES.element) {
        var allElems = tableEntries(TABLES.element);
        for (var j = 0; j < allElems.length; j++) {
          if (Number(allElems[j].id) === targetElemId) {
            newElemId = Number(allElems[j].mergeElementId) || 0;
            break;
          }
        }
      }

      // 3. 兜底推进：若配置表未命中则递增一级
      if (!newElemId && targetElemId > 0) {
        newElemId = targetElemId + 1;
      }

      // 新手教程前期保护：在官方引导 1013 步合成 5 级蔬菜箱之前，限制篮子发射器最高只能到 4 级蔬果篮 (1001104)
      var mergeStep = (role.guide instanceof Map && role.guide.get('Merge')) || 0;
      if (mergeStep < 1013 && newElemId === 1001105) {
        console.warn('[mock-move] 新手引导期防越级保护: 限制方提篮合成，保持 4 级蔬果篮 (1001104)');
        newElemId = 1001104;
      }

      b.incrementId = (Number(b.incrementId) || 100) + 1;
      var mergedCell = {
        elementId: newElemId,
        index: toIdx,
        state: 0,
        hp: 0,
        uUID: b.incrementId,
        seed: Math.floor(Math.random() * 100000) + 1
      };
      trackWeekTaskProgress(role, 0, 1);
      addPassPoints(role, 1);
      addEnergyPassPoints(role, 1);
      if (targetCell) {
        Object.assign(targetCell, mergedCell);
        b.cells.set(toIdx, targetCell);
      } else {
        b.cells.set(toIdx, mergedCell);
      }

      // 4. 处理额外生成的副产物或气泡
      if (Array.isArray(params && params.cells)) {
        params.cells.forEach(function (extra) {
          if (extra && Number(extra.index) !== toIdx && Number(extra.elementId) > 0) {
            b.incrementId = (Number(b.incrementId) || 100) + 1;
            var ec = Object.assign({}, extra, {
              index: Number(extra.index),
              elementId: Number(extra.elementId),
              uUID: b.incrementId,
              seed: Math.floor(Math.random() * 100000) + 1
            });
            b.cells.set(ec.index, ec);
          }
        });
      }

      // 5. 处理 emitCells / emitIndex 产生的格子
      if (Array.isArray(params && params.emitCells)) {
        params.emitCells.forEach(function (ec) {
          if (ec && Number(ec.index) >= 0 && Number(ec.elementId) > 0) {
            b.incrementId = (Number(b.incrementId) || 100) + 1;
            b.cells.set(Number(ec.index), {
              elementId: Number(ec.elementId),
              index: Number(ec.index),
              state: 0,
              hp: 0,
              uUID: b.incrementId,
              seed: Math.floor(Math.random() * 100000) + 1
            });
          }
        });
      }

      console.log('[mock-move] 合成完成: from=' + fromIdx + ' -> to=' + toIdx + ' newElemId=' + newElemId);
    }

    return { ok: true };
  }

  function applyMultipleCellMove(role, params) {
    if (params && Array.isArray(params.moves)) {
      params.moves.forEach(function (m) {
        applyCellMove(role, m);
      });
    }
    return { ok: true };
  }

  function applyChannelBag(role, params) {
    var b = getBoardFor(role);
    if (!b || !b.bag) return { ok: false, error: '背包未就绪' };
    if (!(b.bag.items instanceof Map)) b.bag.items = new Map();
    var capacity = (Number(b.bag.size) || 8) + (Number(b.bag.extSize) || 0);
    if (b.bag.items.size >= capacity) {
      return { ok: false, error: '背包已满' };
    }
    var elemId = null;
    if (b.channel instanceof Map && b.channel.size > 0) {
      var it = b.channel.keys().next();
      if (!it.done) {
        elemId = it.value;
        var obj = b.channel.get(elemId);
        if (obj && obj.value > 1) {
          obj.value--;
        } else {
          b.channel.delete(elemId);
        }
      }
    }
    if (!elemId) return { ok: false, error: '暂存通道为空' };
    var newBagId = 1;
    while (b.bag.items.has(newBagId)) newBagId++;
    var bagCell = { elementId: Number(elemId), state: 0, index: -1, hp: 0 };
    b.bag.items.set(newBagId, bagCell);
    return { ok: true, bagId: newBagId, cell: bagCell };
  }

  function applyLauncherBagPut(role, params) {
    ensureRoleLauncherBag(role);
    var b = getBoardFor(role);
    var launcherId = Number(params && params.launcherId);
    var idx = Number(params && params.index);
    var cell = null;
    if (b && b.cells && idx >= 0 && b.cells.has(idx)) {
      cell = b.cells.get(idx);
      b.cells.delete(idx);
    } else if (b && b.bag && b.bag.items) {
      b.bag.items.forEach(function(v, k) {
        if (!cell && v && v.elementId === launcherId) {
          cell = v;
          b.bag.items.delete(k);
        }
      });
    }
    if (!cell) {
      cell = { elementId: launcherId, state: 0, hp: 0, index: -1 };
    }
    cell.index = -1;
    role.launcherBag.handbook.set(launcherId, true);
    role.launcherBag.items.set(launcherId, cell);
    console.log('[mock-launcherbag] 发射器放入仓库: launcherId=' + launcherId + ', 总数: ' + role.launcherBag.items.size);
    return { ok: true, launcherId: launcherId, cell: cell };
  }

  function applyLauncherBagTakeOut(role, params) {
    ensureRoleLauncherBag(role);
    var b = getBoardFor(role);
    var launcherId = Number(params && params.launcherId);
    var toIndex = Number(params && params.index);
    var cell = role.launcherBag.items.get(launcherId);
    if (!cell) {
      cell = { elementId: launcherId, state: 0, hp: 0, index: toIndex };
    }
    role.launcherBag.items.delete(launcherId);
    cell.index = toIndex;
    if (b && b.cells) {
      b.cells.set(toIndex, cell);
    }
    console.log('[mock-launcherbag] 发射器取出到棋盘: launcherId=' + launcherId + ' -> toIndex=' + toIndex);
    return { ok: true, launcherId: launcherId, cell: cell };
  }

  function applyLauncherBagRecycle(role, params) {
    ensureRoleLauncherBag(role);
    var producerId = Number(params && params.producerId);
    if (role.launcherBag.items.has(producerId)) {
      role.launcherBag.items.delete(producerId);
    }
    var energyGain = 30;
    if (role.energy) {
      role.energy.value = (role.energy.value || 0) + energyGain;
    }
    console.log('[mock-launcherbag] 回收发射器: producerId=' + producerId + ', 补偿体力: ' + energyGain);
    return { ok: true, rewards: [{ type: 4, id: 0, count: energyGain }] };
  }

  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; saveNow(); }, 600);
  }

  function hasSavedRole() {
    try { return !!nativeLocalStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  }

  // 每次页面生命周期只恢复一次:RPC 期间反复重放存档会把客户端刚写入的活体状态
  //(如 bon 解码出的 Date 实例)覆盖回序列化残骸,曾导致 createAt 变 {__d:0} 引发
  //getNaturalCreateDay 的 .getDay 崩溃、登录后引导链断裂卡 98%
  var restoreDone = false;
  function restoreSavedRole(role) {
    if (restoreDone) return false;
    try {
      var raw = nativeLocalStorage.getItem(SAVE_KEY);
      if (!raw) { restoreDone = true; return false; }
      var saved = deepRevive(JSON.parse(raw), 0);
      if (!saved || !(saved.boards instanceof Map)) { restoreDone = true; return false; }
      var b1 = saved.boards.get(1);
      if (!b1 || !(b1.cells instanceof Map) || b1.cells.size === 0) { restoreDone = true; return false; }
      for (var k in saved) {
        if (k === 'energy') continue; // energy 单独处理:恢复数值但兜底逻辑照跑
        try { role[k] = saved[k]; } catch (e) {}
      }
      if (saved.energy) {
        role.energy = saved.energy;
      }
      restoreDone = true;
      // 恢复是登录链上对 role 的最后一次整批写入,而 initRole 的规整跑在恢复之前会被覆盖。
      //createAt 若以 {__d:0} 对象形态留到 PV.init 的 checkRetention,getDay() 当场断链(卡98%),
      //故恢复完必须立即强制规整(以恢复后状态为准)
      coerceCreateAt(role);
      // 引导进度 Map 正常规整，绝不强行跳过新手开场漫画与教程
      if (!(role.guide instanceof Map)) role.guide = new Map();
      // 订单播种:早期存档 board.orders 为空(当时假服务器从不发订单),按配置补种当前抽屉
      ensureOrdersSeeded(role);
      // 旧档兜底:早期存档无 role.shop(窗口打开即崩,见 ensureRoleShop 注释)
      ensureRoleShop(role);
      ensureRoleLauncherBag(role);
      ensureRoleBoxes(role);
      ensureRoleWeekTask(role);
      ensureRoleMails(role);
      ensureRolePass(role);
      ensureRoleEnergyPass(role);
      ensureRoleWeightRace(role);
      ensureRoleGymSprint(role);
      if (b1 && b1.bag) {
        if (!b1.bag.size) b1.bag.size = 8;
        if (!(b1.bag.items instanceof Map)) b1.bag.items = new Map();
        if (b1.bag.items instanceof Map) {
          b1.bag.items.forEach(function (v, k) {
            if (!v || !v.elementId) b1.bag.items.delete(k);
          });
        }
      }
      console.log('[mock-save] 已恢复本地存档: cells=' + b1.cells.size + ', id=' + saved.id);
      window.__mockLastRestore = { ok: true, err: null, at: Date.now() };
      return true;
    } catch (e) {
      console.warn('[mock-save] 存档恢复失败,改用全新开局:', e && e.message);
      window.__mockLastRestore = { ok: false, err: String(e && e.stack || e).slice(0, 300), at: Date.now() };
      return false;
    }
  }

  const initialBoard1Elements = [
    ["1001103:3:1", "1002401:3:2", "1002302:3:4", "1004201:1", "1002104:1", "1001103:3:1", "1001104:3:3"],
    ["3001003:1", "1002501:1", "1002401:1", "1004103:1", "1001104:1", "3003003:1", "1002302:1"],
    ["1001303:3:3", "1002101:3:4", "1001103:3:1", "1001102:3:3", "1001103:3:2", "1001104:1", "1001205:3:4"],
    ["1001301:3:1", "1002102:1", "1001203:1", "1001202:1", "1001103:1", "1001204:3:4", "1002301:3:2"],
    ["1002103:3:2", "1002103:1", "1001101:0", "1001101:0", "1001102:1", "1002201:3:1", "1001204:3:2"],
    ["1002103:3:4", "1001204:3:2", "1002101:1", "1002102:1", "1002103:1", "1001101:3:3", "1001103:3:1"],
    ["1004201:1", "1004301:1", "1001301:1", "1001201:1", "1004201:1", "1004202:1", "1002201:1"],
    ["1004301:1", "1004302:1", "1003201:1", "1003101:0", "1003103:1", "1003302:1", "1003301:1"],
    ["1003201:3:1", "1002501:1", "1003301:3:2", "1003102:1", "1003204:3:4", "1003202:1", "1003201:3:3"]
  ];

  function createBoard1Cells() {
    const cells = new Map();
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 7; c++) {
        let index = r * 7 + c + 1;
        let parts = initialBoard1Elements[r][c].split(":");
        let elementId = parseInt(parts[0]);
        let state = parseInt(parts[1]);
        let seed = parts.length > 2 ? parseInt(parts[2]) : 0;
        cells.set(index, {
          uUID: 1000 + index,
          seed: seed,
          index: index,
          elementId: elementId,
          state: state,
          productType: 0,
          bubbleEnd: 0,
          deteriorateEnd: 0,
          openEnd: 0,
          pauseTime: 0,
          endTime: 0,
          processTime: 0,
          skills: new Map(),
          order: null,
          orderBegin: [],
          hp: new Map(),
          recovery: null,
          productCount: 0,
          autoProductCount: 0,
          extra: new Map(),
          hiddenPocket: [],
          cost: 0
        });
      }
    }
    return cells;
  }

  function initRole(role) {
    if (!role) return;
    // 存档恢复不在这里做:客户端登录流程会 reset() 重造 role,过早恢复会被冲掉。
    //正确时机是 sendAsync 的 game_rolelogin 分支(见 setupNet)
    if (!role.id) role.id = 10001;
    // createAt 必须是真正的 Date 实例:客户端留存统计(createAt.getDay())直接调用,
    //序列化往返可能留下 {__d:ms} 标记对象或 ISO 字符串,这里统一规整;
    //无效值(0/NaN,如坏档 {__d:0})一律用当前时间,避免 1970 纪元
    if (!(role.createAt instanceof Date) || !(role.createAt.getTime() > 0)) {
      var ca = role.createAt;
      var ms = ca && typeof ca === 'object' && ca.__d !== undefined ? Number(ca.__d) : Number(ca);
      if (!isFinite(ms) || ms <= 0) ms = Date.now();
      role.createAt = new Date(ms);
    }
    if (!role.uId) role.uId = 1;
    if (!role.loginTime) role.loginTime = Date.now();
    if (!role.userInfo) {
      role.userInfo = { firstChannel: 'weixin', nickName: '胖鹅' };
    } else {
      role.userInfo.firstChannel = 'weixin';
      role.userInfo.nickName = '胖鹅';
    }
    if (!role.boards) role.boards = new Map();
    if (!role.boards.has(1)) {
      role.boards.set(1, {
        id: 1,
        boardId: 1,
        rId: 10001,
        activityId: 0,
        gActId: 0,
        incrementId: 100,
        type: 1, // Uo.main
        rows: 9,
        cols: 7,
        cellSize: 96,
        cells: createBoard1Cells(),
        bag: {
          size: 8,
          extSize: 0,
          mpAid: 0,
          mpSize: 0,
          items: new Map(),
          mpItems: new Map(),
          producerSize: 0,
          producerItems: new Map(),
          passNewAid: 0,
          passNewSize: 0,
          passNewItems: new Map(),
          wasteBasket: new Map(),
          mpV2Aid: 0,
          mpV2Size: 0,
          mpV2Items: new Map()
        },
        tutorialOrder: new Map([
          ['Vegetable_1', [1001201, 1001201, 1001201, 1001201, 1001201, 1001301]]
        ]),
        seriesInitOrder: new Map(),
        deterioratedInit: new Map(),
        energyEnd: 0,
        freeSpeedUpTimes: 0,
        freeRechargeTimes: 0,
        freeSeries: new Map(),
        channel: new Map(),
        channelCells: new Map(),
        orders: new Map(),
        ordered: new Map(),
        orderDrawerEndId: 0,
        orderDrawerNeedReward: new Map(),
        pins: [],
        lastEnterAt: 0,
        stableRandom: new Map(),
        specialCount: new Map(),
        buff: new Map(),
        extraField: new Map(),
        areaRewarded: new Map(),
        lenientAutoBox: false
      });
    } else {
      var b1 = role.boards.get(1);
      if (!b1.cells || b1.cells.size === 0) {
        b1.cells = createBoard1Cells();
      }
      if (!b1.buff) b1.buff = new Map();
      if (!b1.tutorialOrder || !(b1.tutorialOrder instanceof Map) || b1.tutorialOrder.size === 0) {
        b1.tutorialOrder = new Map([
          ['Vegetable_1', [1001201, 1001201, 1001201, 1001201, 1001201, 1001301]]
        ]);
      }
    }
    if (!role.energy || !role.energy.valueMax) {
      role.energy = {
        value: 100,
        valueMax: 100,
        interval: 120,
        intervalValue: 1,
        startTime: 0,
        pauseTime: 0,
        state: 0,
        id: "energy",
        reset: function() { this.value = 100; this.valueMax = 100; }
      };
    } else {
      if (!role.energy.valueMax || role.energy.valueMax < 100) role.energy.valueMax = 100;
      // 有存档时保留真实体力值(离线自然恢复交给游戏自己的 energyEnd 逻辑);
      // 仅无存档的全新 role 才慷慨补满,方便首次体验
      if (!hasSavedRole() && role.energy.value < 100) role.energy.value = 100;
      if (!role.energy.interval) role.energy.interval = 120;
      if (!role.energy.intervalValue) role.energy.intervalValue = 1;
      if (typeof role.energy.reset !== 'function') {
        role.energy.reset = function() { this.value = 100; this.valueMax = 100; };
      }
    }
    var now = Date.now();
    // 跨天日界(B2):只对无存档新档兜底(当天 24:00 自然日界)。有存档时原样保留——
    //过期值正是登录后触发 dayRefresh 的正确输入;每次推 +24h 会把日界永久顶出去,
    //玩家永远跨不了天(旧版此处的雷)
    if (!hasSavedRole()) {
      if (!role.dayEndTime || role.dayEndTime <= now) role.dayEndTime = endOfToday();
    }
    // 建造线初始状态(es 类 L7043):Area1 autoUnlock=1 → 新档 areas=[1](1001 的
    //UnlockArea1 由此满足);Map 字段齐备防旧档缺字段
    if (!role.build) {
      role.build = { nextBuildCoin: 0, buildCoinCache: new Map(), builds: new Map(), areas: [1], areaReward: new Map(), adorns: new Map(), discount: new Map(), builded: new Map() };
    } else {
      var bb = role.build;
      if (!(bb.buildCoinCache instanceof Map)) bb.buildCoinCache = new Map();
      if (!(bb.builds instanceof Map)) bb.builds = new Map();
      if (!(bb.areas instanceof Array)) bb.areas = [];
      if (!(bb.areaReward instanceof Map)) bb.areaReward = new Map();
      if (!(bb.adorns instanceof Map)) bb.adorns = new Map();
      if (!(bb.discount instanceof Map)) bb.discount = new Map();
      if (!(bb.builded instanceof Map)) bb.builded = new Map();
      if (bb.areas.length === 0 && bb.builded.size === 0) bb.areas.push(1); // 老空档补
    }
    // 新肥鹅记录(is 类 L7112):build 奖励 goose<id> 时登记
    if (!role.goose || !(role.goose.gooses instanceof Map)) role.goose = { gooses: new Map() };
    if (!(role.handbookRewarded instanceof Map)) role.handbookRewarded = new Map();
    if (!role.guide) role.guide = new Map();
    if (!role.unconfirmedOrders) role.unconfirmedOrders = [];
    if (!role.refunds) role.refunds = new Map();
    if (!role.activityOnceData) role.activityOnceData = new Map();
    if (!role.onceData) role.onceData = new Map();
    if (!role.specialCount) role.specialCount = new Map();
    if (!role.bagSkin) role.bagSkin = new Map();
    ensureRoleLauncherBag(role);
    var initB1 = role.boards && role.boards.get(1);
    if (initB1 && initB1.bag) {
      if (!initB1.bag.size) initB1.bag.size = 8;
      if (!(initB1.bag.items instanceof Map)) initB1.bag.items = new Map();
    }
    if (!role.shop) role.shop = new Map();
    ensureRoleShop(role); // 表未到时幂等跳过,loadGameTables 的 Shop 回调会补
    if (!role.statistic) role.statistic = new Map();
    if (!role.redDot) role.redDot = new Map();
    if (!role.dailyEvent) role.dailyEvent = new Map();
    if (!role.daily00Event) role.daily00Event = new Map();
    if (!role.globalActivity) role.globalActivity = new Map();
    ensureRoleBoxes(role);
    ensureRoleWeekTask(role);
    ensureRoleMails(role);
    ensureRolePass(role);
    ensureRoleEnergyPass(role);
    ensureRoleWeightRace(role);
    ensureRoleGymSprint(role);
    // 新档播种(客户端按 unlock 过滤,教程期未解锁不可见,不影响引导);
    //有存档时等 rolelogin 恢复后再种(restoreSavedRole/loadOrderConfig 负责),
    //不在"恢复前窗口"碰 role
    if (!hasSavedRole() || restoreDone) ensureOrdersSeeded(role);
    console.log('[mock-network] Role 数据已就绪, roleId:', role.id, 'MainBoard cells:', role.boards.get(1).cells.size, hasSavedRole() ? '(存档待 rolelogin 注入)' : '(全新开局)');
  }

  // wsDelegate 的 connected/connectionState 是 Ro.prototype 上的 getter(只读访问器),
  // 普通赋值 `wsd.connected = true` 会因无 setter 被静默忽略 → 客户端 c8 装饰器
  // (onBuildClick 等)检查 Nu.wsDelegate.connected 恒为假 → 报"网络环境差,请检查网络"。
  // 解法:给 wsDelegate 实例装假 socket(connected=true, state=Running)让原型 getter 命中,
  // 再遮蔽 connected/connectionState getter 兜底,防假 socket 被重连路径冲掉。
  function installNetState(wsd, Nu) {
    if (!wsd) return;
    var fake = {
      connected: true,
      connectionState: 2, // go.Running
      send: function () { scheduleSave(); },
      sendAsync: function (e) { return Nu.sendAsync(e); },
      destroy: function () {},
      reset: function () {},
      connect: function () {},
      interrupt: function () {},
      on: function () {},
      once: function () {},
      off: function () {},
      emit: function () {}
    };
    try { wsd.socket = fake; } catch (e) { console.warn('[mock-network] 装假 socket 失败', e); }
    try {
      Object.defineProperty(wsd, 'connected', { get: function () { return true; }, configurable: true });
      Object.defineProperty(wsd, 'connectionState', { get: function () { return 2; }, configurable: true });
    } catch (e) {
      console.warn('[mock-network] wsDelegate 状态遮蔽失败', e);
    }
    wsd.send = function (e) { scheduleSave(); };
    wsd.sendAsync = function (e) { return Nu.sendAsync(e); };
    wsd.connect = function () { return Promise.resolve(true); }; // 阻断重连路径重造真实 socket
    wsd.connected = true;      // 兜底(万一有 own 可写属性路径)
    wsd.connectionState = 2;
  }

  function setupNet(Nu) {
    if (!Nu) return;
    console.log('[mock-network] 正在拦截 window.net / Nu RPC 接口...');

    // 1. 拦截 HTTP 异步调用 (主要用于 login_authuser)
    Nu.sendHttpAsync = function(t) {
      console.log('[mock-network] sendHttpAsync =>', t.cmd, t.params);
      if (t.cmd === 'login_authuser') {
        return Promise.resolve({
          code: 0,
          getData: function() {
            return {
              // 有存档 = 回归老玩家(跳过新玩家建档模板),无存档 = 新玩家
              isNew: !hasSavedRole(),
              user: {
                id: "10001",
                platformUId: "local_puid_1",
                name: "胖鹅",
                authed: true
              },
              moreUsers: []
            };
          },
          rawData: {
            roleToken: "mock_role_token_123"
          }
        });
      }
      return Promise.resolve({
        code: 0,
        getData: function() { return {}; },
        rawData: { code: 0 }
      });
    };

    // 2. 拦截 WebSocket 连接
    Nu.connect = function(opts) {
      console.log('[mock-network] Nu.connect 调用参数:', opts);
      Nu.connectOptions = opts;
      if (opts && opts.root && opts.root.role) {
        initRole(opts.root.role);
      }
      if (window._user_mgr_ && window._user_mgr_.role) {
        initRole(window._user_mgr_.role);
      }
      if (Nu.wsDelegate) {
        installNetState(Nu.wsDelegate, Nu);
        setTimeout(function() {
          if (Nu.wsDelegate.events) {
            Nu.wsDelegate.events.emit('e_connected', { use: 'mock', url: 'mock://localhost' });
          }
        }, 10);
      }
      return Promise.resolve(true);
    };

    // 3. 拦截 WebSocket 异步 RPC (game_rolelogin / game_enterboard / game_guidesave 等)
    Nu.sendAsync = function(t) {
      console.log('[mock-network] sendAsync =>', t.cmd, t.params);
      var currentRole = (window._user_mgr_ && window._user_mgr_.role) || (Nu.connectOptions && Nu.connectOptions.root && Nu.connectOptions.root.role);
      if (currentRole) {
        initRole(currentRole);
      }
      // 引导进度写回(见 applyGuideSave 注释)
      if (currentRole && /guidesave/.test(t && t.cmd || '')) {
        applyGuideSave(currentRole, t && t.params);
      }
      // 订单完成写回(见 applyCompleteOrder):ordered/orderDrawerEndId/orders 客户端零写入,
      //不代写则完成态刷新即丢、订单复活可重复交单刷币
      if (currentRole && (t && t.cmd) === 'game_completeorder') {
        applyCompleteOrder(currentRole, t.params);
      }
      // ===== B1/B2/B4:响应携带数据的 RPC(客户端消费 getData() 具体字段) =====
      var gcmd = ((t && t.cmd) || '').toLowerCase();
      // 棋盘加速/买CD: 包含做菜钻石加速、菜篮子/生成器充能加速
      if (currentRole && gcmd === 'game_cellbuycd') {
        var cost = Number(t.params && t.params.cost) || 0;
        if (cost > 0) {
          currentRole.diamond = Math.max(0, (currentRole.diamond || 0) - cost);
          console.log('[mock-network] 消费钻石 cellBuyCd: -' + cost + ' 剩余:' + currentRole.diamond);
          scheduleSave();
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'game_build') {
        var bres = applyBuild(currentRole, t.params);
        var respData = {
          code: bres ? 0 : 1,
          role: currentRole,
          rewards: bres ? bres.rewards : [],
          rewards2: bres ? bres.rewards2 : []
        };
        return Promise.resolve({
          cmd: t.cmd,
          code: bres ? 0 : 1,
          getData: function () { return respData; },
          rawData: respData
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (gcmd === 'game_gm') {
        return Promise.resolve({
          code: 0,
          getData: function () { return { extra: [] }; },
          rawData: { code: 0, extra: [] }
        });
      }
      if (gcmd === 'game_currenttimestamp') {
        // syncRole(L117792)无条件 dayEndTime=getData().dayEnd,缺字段会把日界写成 undefined
        return Promise.resolve({
          code: 0,
          getData: function () { return { ts: Date.now(), dayEnd: (currentRole && currentRole.dayEndTime) || endOfToday() }; },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'game_dayrefresh') {
        var dres = applyDayRefresh(currentRole);
        ensureRoleWeekTask(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () {
            var acts = currentRole.globalActivity ? Array.from(currentRole.globalActivity.values()) : [];
            return { role: currentRole, globalActivity: acts, cookV2: true, dayEnd: dres.dayEnd };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_orderdrawerreward') {
        var drres = applyDrawerReward(currentRole, t.params);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: drres.rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_arearewardget') {
        var arres = applyAreaRewardGet(currentRole, t.params);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: arres.rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_claimboardareareward') {
        var crres = applyClaimBoardAreaReward(currentRole, t.params);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: crres.rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_goosereward') {
        var gwres = applyGooseReward(currentRole, t.params);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: gwres.rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_getelementhandbook') {
        var hbmap = buildHandbook(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () { return { handbook: hbmap }; },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'game_elementhandbookreward') {
        var hbres = applyElementHandBookReward(currentRole, t.params);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: hbres.rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_levelup') {
        var lpres = applyLevelUp(currentRole);
        return Promise.resolve({
          code: lpres.ok ? 0 : 1,
          getData: function () { return { rewards: lpres.rewards, adIdStatus: 0 }; },
          rawData: { code: lpres.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      // ===== B3 做饭链(cookV2):开火响应必须带 cells 数组供 GetActionCellRemoteCell
      //校验(orderId/state>=running),否则客户端整板远端重建;其余确认即可
      if (currentRole && gcmd === 'game_cookstart') {
        var csCell = applyCookStart(currentRole, t.params);
        return Promise.resolve({
          code: csCell ? 0 : 1,
          getData: function () { return { cells: csCell ? [csCell] : [], role: currentRole }; },
          rawData: { code: csCell ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_cookputingredients') {
        applyCookPut(currentRole, t.params);
      }
      if (currentRole && gcmd === 'game_cooktakeingredient') {
        applyCookTake(currentRole, t.params);
      }
      if (currentRole && gcmd === 'game_cookcancel') {
        applyCookCancel(currentRole, t.params);
      }
      if (currentRole && (gcmd === 'game_cookcollect' || gcmd === 'game_cookcollectbatch')) {
        applyCookCollect(currentRole, t.params);
      }
      // ===== 商店系统 RPC =====
      if (currentRole && gcmd === 'game_shopbuy') {
        var sbres = applyShopBuy(currentRole, t.params);
        return Promise.resolve({
          code: sbres.code,
          getData: function () { return { rewards: sbres.rewards }; },
          rawData: { code: sbres.code }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_shoplook') {
        return Promise.resolve({
          code: 0,
          getData: function () { return {}; },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'game_shopcheck') {
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'game_shoprefresh') {
        var srfres = applyShopRefresh(currentRole, t.params);
        return Promise.resolve({
          code: srfres.code,
          getData: function () { return { role: currentRole }; },
          rawData: { code: srfres.code }
        }).then(function (r) { scheduleSave(); return r; });
      }
      // ===== 通道物品飞入棋盘 (channelPut) =====
      // 客户端 take() 依赖响应带 cells 供 GetActionCellRemoteCell 与 syncChannelPutCellFromResponse
      if (currentRole && gcmd === 'game_channelput') {
        var cpCell = applyChannelPut(currentRole, t.params);
        return Promise.resolve({
          code: cpCell ? 0 : 1,
          getData: function () {
            return {
              cells: cpCell ? [cpCell] : [],
              role: currentRole
            };
          },
          rawData: { code: cpCell ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      // ===== 阶段二：常规背包与发射器仓库 RPC =====
      if (currentRole && gcmd === 'game_bagbuy') {
        var bbRes = applyBagBuy(currentRole, t.params);
        return Promise.resolve({
          code: bbRes.ok ? 0 : 1,
          error: bbRes.error || '',
          getData: function () { return { role: currentRole }; },
          rawData: { code: bbRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_celltobag') {
        var ctbRes = applyCellToBag(currentRole, t.params);
        return Promise.resolve({
          code: ctbRes.ok ? 0 : 1,
          error: ctbRes.error || '',
          getData: function () { return { role: currentRole }; },
          rawData: { code: ctbRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_cellbagput') {
        var cbpRes = applyCellBagPut(currentRole, t.params);
        return Promise.resolve({
          code: cbpRes.ok ? 0 : 1,
          error: cbpRes.error || '',
          getData: function () {
            return {
              role: currentRole,
              cells: cbpRes.cell ? [cbpRes.cell] : []
            };
          },
          rawData: { code: cbpRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_cellmove') {
        var cmRes = applyCellMove(currentRole, t.params);
        return Promise.resolve({
          code: cmRes.ok ? 0 : 1,
          error: cmRes.error || '',
          getData: function () {
            return {
              role: currentRole
            };
          },
          rawData: { code: cmRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_multiplecellmove') {
        var mcmRes = applyMultipleCellMove(currentRole, t.params);
        return Promise.resolve({
          code: mcmRes.ok ? 0 : 1,
          error: mcmRes.error || '',
          getData: function () {
            return {
              role: currentRole
            };
          },
          rawData: { code: mcmRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'game_channelbag') {
        var chbRes = applyChannelBag(currentRole, t.params);
        return Promise.resolve({
          code: chbRes.ok ? 0 : 1,
          error: chbRes.error || '',
          getData: function () { return { role: currentRole }; },
          rawData: { code: chbRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      // ===== 阶段三：相册与店长形象系统 (ImgBox) RPC =====
      if (currentRole && gcmd === 'imgbox_show') {
        ensureRoleBoxes(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              role: currentRole,
              boxes: currentRole.boxes,
              nameChangeRemain: 0
            };
          },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'imgbox_edit') {
        ensureRoleBoxes(currentRole);
        var p = t.params || {};
        if (!currentRole.userInfo) currentRole.userInfo = {};
        if (p.name) currentRole.userInfo.name = p.name;
        if (p.img) currentRole.userInfo.img = p.img;
        if (p.imgBox > 0) currentRole.userInfo.imgBox = p.imgBox;
        if (p.uniform > 0) currentRole.userInfo.uniform = p.uniform;
        if (typeof p.pet !== 'undefined') currentRole.userInfo.pet = p.pet;
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'imgbox_unlock') {
        ensureRoleBoxes(currentRole);
        var p = t.params || {};
        var uType = p.type;
        var uId = Number(p.id);
        if (currentRole.boxes) {
          if ((uType === 8 || uType === 'uniform') && currentRole.boxes.uniform) currentRole.boxes.uniform.set(uId, { count: 1 });
          else if ((uType === 7 || uType === 'img') && currentRole.boxes.img) currentRole.boxes.img.set(uId, { count: 1 });
          else if ((uType === 9 || uType === 'imgBox') && currentRole.boxes.boxes) currentRole.boxes.boxes.set(uId, { count: 1 });
          else if ((uType === 10 || uType === 'pet') && currentRole.boxes.pet) currentRole.boxes.pet.set(uId, { count: 1, name: '' });
          else if (currentRole.boxes.uniform) currentRole.boxes.uniform.set(uId, { count: 1 });
        }
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              role: currentRole,
              boxes: currentRole.boxes,
              rewards: []
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'imgbox_wearbadge') {
        var bId = Number(t.params && t.params.badgeId) || 0;
        if (!currentRole.userInfo) currentRole.userInfo = {};
        currentRole.userInfo.wearBadgeId = bId;
        currentRole.userInfo.wearBadgeIdV2 = bId > 0 ? [bId] : [];
        if (currentRole.boxes && currentRole.boxes.badge && bId > 0) {
          currentRole.boxes.badge.set(bId, { count: 1 });
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'imgbox_editpetname') {
        var p = t.params || {};
        var petId = Number(p.pet);
        var petName = String(p.petName || '');
        if (currentRole.boxes && currentRole.boxes.pet && currentRole.boxes.pet.has(petId)) {
          var pData = currentRole.boxes.pet.get(petId) || {};
          pData.name = petName;
          currentRole.boxes.pet.set(petId, pData);
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // ===== 阶段三：日常与周常任务体系 (WeekTask) RPC =====
      if (currentRole && gcmd === 'weektask_syncprogress') {
        ensureRoleWeekTask(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'weektask_synccyclelogin') {
        ensureRoleWeekTask(currentRole);
        trackWeekTaskProgress(currentRole, 4, 1);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'weektask_claimtaskreward') {
        var wtRes = applyWeekTaskClaim(currentRole, t.params);
        return Promise.resolve({
          code: wtRes.ok ? 0 : 1,
          error: wtRes.error || '',
          getData: function () {
            return {
              role: currentRole,
              rewards: wtRes.rewards || []
            };
          },
          rawData: { code: wtRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'weektask_claimprogressreward') {
        var wpRes = applyWeekProgressClaim(currentRole, t.params);
        return Promise.resolve({
          code: wpRes.ok ? 0 : 1,
          error: wpRes.error || '',
          getData: function () {
            return {
              role: currentRole,
              rewards: wpRes.rewards || []
            };
          },
          rawData: { code: wpRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'weektask_claimlastweekreward') {
        ensureRoleWeekTask(currentRole);
        var wt = currentRole.weekTask && currentRole.weekTask.get(101);
        var lastRewards = [];
        if (wt && wt.lastWeekTaskRewards && wt.lastWeekTaskRewards.length) {
          lastRewards = wt.lastWeekTaskRewards.slice();
          wt.lastWeekTaskRewards = [];
        }
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              role: currentRole,
              rewards: lastRewards
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'weektask_weekfresh') {
        ensureRoleWeekTask(currentRole);
        var wt = currentRole.weekTask && currentRole.weekTask.get(101);
        if (wt) {
          wt.taskProgress = new Map([ [4, 1], [0, 0], [6, 0], [3, 0], [5, 0], [1, 0] ]);
          wt.taskRewarded = new Map();
          wt.progressScore = 0;
          wt.progressRewarded = new Map();
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'launcherbag_show') {
        ensureRoleLauncherBag(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'launcherbag_put') {
        var lbpRes = applyLauncherBagPut(currentRole, t.params);
        return Promise.resolve({
          code: lbpRes.ok ? 0 : 1,
          error: lbpRes.error || '',
          getData: function () { return { role: currentRole }; },
          rawData: { code: lbpRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'launcherbag_takeout') {
        var lbtRes = applyLauncherBagTakeOut(currentRole, t.params);
        return Promise.resolve({
          code: lbtRes.ok ? 0 : 1,
          error: lbtRes.error || '',
          getData: function () {
            return {
              role: currentRole,
              cells: lbtRes.cell ? [lbtRes.cell] : []
            };
          },
          rawData: { code: lbtRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'launcherbag_recycle') {
        var lbrRes = applyLauncherBagRecycle(currentRole, t.params);
        return Promise.resolve({
          code: lbrRes.ok ? 0 : 1,
          error: lbrRes.error || '',
          getData: function () {
            return {
              role: currentRole,
              rewards: lbrRes.rewards || []
            };
          },
          rawData: { code: lbrRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // ===== 阶段四：系统信箱与福利体系 RPC =====
      if (currentRole && gcmd === 'game_getmails') {
        ensureRoleMails(currentRole);
        ensureAllExtendedActivities(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () {
            return { mails: currentRole.mails || [] };
          },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'game_readmail') {
        ensureRoleMails(currentRole);
        var mId = Number(t.params && t.params.id);
        var found = (currentRole.mails || []).find(function (m) { return Number(m.id) === mId; });
        if (found && found.state === 1) {
          found.state = 2; // yr.read
          if (!found.haveAttachments) {
            currentRole.mailNewCount = Math.max(0, (currentRole.mailNewCount || 0) - 1);
          }
          scheduleSave();
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'game_attachmentmail') {
        ensureRoleMails(currentRole);
        var mId = Number(t.params && t.params.id);
        var found = (currentRole.mails || []).find(function (m) { return Number(m.id) === mId; });
        var mailRewards = [];
        if (found && found.state < 3) {
          found.state = 3; // yr.attachmentGot
          mailRewards = found.rewards || [];
          grantCurrency(currentRole, mailRewards);
          grantChannelElements(currentRole, mailRewards, 'mail');
          currentRole.mailNewCount = Math.max(0, (currentRole.mailNewCount || 0) - 1);
          console.log('[mock-mail] 成功领取邮件 ' + mId + ' 附件奖励:', mailRewards);
          scheduleSave();
        }
        return Promise.resolve({
          code: 0,
          getData: function () {
            return { role: currentRole, rewards: mailRewards };
          },
          rawData: { code: 0 }
        });
      }
      if (currentRole && gcmd === 'newplayergift_reward') {
        var pId = Number(t.params && t.params.id) || 1;
        var npRewards = [
          { itemType: 4, itemId: 0, value: 50 },  // 体力
          { itemType: 2, itemId: 0, value: 30 },  // 钻石
          { itemType: 1, itemId: 0, value: 1000 } // 金币
        ];
        grantCurrency(currentRole, npRewards);
        grantChannelElements(currentRole, npRewards, 'newPlayerGift');
        if (!currentRole.newPlayerGift) currentRole.newPlayerGift = new Map();
        currentRole.newPlayerGift.set(pId, { rewarded: true });
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: npRewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'wechatsubscription_subscribe') {
        if (!currentRole.weChatSubscription) currentRole.weChatSubscription = { subscribed: new Map() };
        if (!(currentRole.weChatSubscription.subscribed instanceof Map)) currentRole.weChatSubscription.subscribed = new Map();
        var pTypes = t.params && t.params.types || [];
        pTypes.forEach(function (ty) {
          currentRole.weChatSubscription.subscribed.set(ty, Boolean(t.params.isSubscribe));
        });
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'wechatsubscription_claimreward') {
        var subRewards = [
          { itemType: 4, itemId: 0, value: 30 }, // 30 体力
          { itemType: 2, itemId: 0, value: 20 }  // 20 钻石
        ];
        grantCurrency(currentRole, subRewards);
        grantChannelElements(currentRole, subRewards, 'subscription');
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: subRewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }
      if (currentRole && gcmd === 'cdgift_gettutorialprop') {
        var cdRewards = [{ itemType: 5, itemId: 0, value: 5 }]; // 赠送 5 张生产加速券
        grantCurrency(currentRole, cdRewards);
        grantChannelElements(currentRole, cdRewards, 'cdGift');
        console.log('[mock-network] 成功发放 CD 礼包引导道具:', cdRewards);
        return Promise.resolve({
          code: 0,
          getData: function () {
            return { role: currentRole, rewards: cdRewards };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // ===== 阶段五：通行证系统与竞赛/排行榜核心 RPC =====

      if (currentRole && (gcmd === 'shop_buygift' || gcmd.includes('buygift'))) {
        var buyItemId = Number(t.params && t.params.itemId) || 0;
        console.log('%c[mock-shop] 触发礼包购买 RPC shop_buygift, itemId: ' + buyItemId, 'color: #00ff00; font-weight: bold;');
        var instantRewards = [];

        // 1. 赛季通行证 VIP / SVIP (10010101 ~ 10010109)
        var isPassVip = (buyItemId >= 10010101 && buyItemId <= 10010109);
        // 2. 棋盘通行证高级会员 (9950101 ~ 9950406)
        var isPBPassVip = (buyItemId >= 9950101 && buyItemId <= 9950406) || String(buyItemId).startsWith('995');
        // 3. 能量挑战进阶版 (991001)
        var isEnergyPassVip = (buyItemId === 991001);

        if (isPassVip) {
          ensureRolePass(currentRole);
          var pData = currentRole.pass && currentRole.pass.get(10001);
          var isSVIP = (buyItemId === 10010102 || buyItemId === 10010105 || buyItemId === 10010108 || buyItemId === 10010103 || buyItemId === 10010106 || buyItemId === 10010109);
          var vipType = isSVIP ? 2 : 1; // 1: 普通VIP, 2: 高级会员SVIP

          if (pData) {
            pData.status = vipType;
            if (isSVIP) {
              // 高级会员 (SVIP) 特权：立即赠送 10 级进度 (+20 积分)
              pData.passPoint = Math.max(pData.passPoint || 0, 20);
              console.log('[mock-pass] 购买高级会员 (SVIP) 成功！立即赠送 10 级进度，当前积分: ' + pData.passPoint);
            } else {
              console.log('[mock-pass] 购买普通会员 (VIP) 成功！');
            }
          }
          if (window.d3 && window.d3.role && window.d3.role.pass) {
            var liveP = window.d3.role.pass.get(10001);
            if (liveP) {
              liveP.status = vipType;
              if (isSVIP && pData) liveP.passPoint = pData.passPoint;
            }
          }

          instantRewards = [
            { itemType: 4, itemId: 0, value: 100 },
            { itemType: 2, itemId: 0, value: 50 },
            { itemType: 5, itemId: 0, value: 50 }
          ];
          grantCurrency(currentRole, instantRewards);
          grantChannelElements(currentRole, instantRewards, 'pass_vip_buy');

          // 延时派发解锁动画与重绘
          setTimeout(function () {
            if (window.w && window.g) {
              window.w.emit(window.g.OnPaySucceed, { goodsIds: [buyItemId.toString()] });
              if (vipType === 2) {
                window.w.emit(window.g.PassSvipUnlocked, { aid: 10001 });
                window.w.emit(window.g.PassVipUpgrade, { aid: 10001 });
              } else {
                window.w.emit(window.g.PassVipUnlocked, { aid: 10001 });
              }
            }
            if (window.PassWindow) {
              try {
                if (typeof window.PassWindow.renderButton === 'function') window.PassWindow.renderButton();
                if (window.PassWindow.activity && typeof window.PassWindow.render === 'function') {
                  var pnt = window.PassWindow.activity.readLastAnimatedPoint();
                  window.PassWindow.render(pnt);
                }
                if (window.PassWindow.layoutPassTask && window.PassWindow.layoutPassTask.node) {
                  var items = window.PassWindow.layoutPassTask.node.getComponentsInChildren('ZEe') || [];
                  items.forEach(function (it) {
                    if (it && typeof it.vipUnlockAnim === 'function') it.vipUnlockAnim();
                  });
                }
              } catch (e) {}
            }
          }, 60);

        } else if (isPBPassVip) {
          // 棋盘活动独立处理
          function applyChessPBPass(r) {
            if (!r) return;
            if (!r.chess7) r.chess7 = new Map();
            if (!(r.chess7 instanceof Map)) r.chess7 = new Map();
            if (r.chess7.size === 0) {
              r.chess7.set(101, {
                boardId: 101,
                progressBoardPass: {
                  passAid: 40001,
                  activityID: 'progressPass1',
                  rewardTier: '1',
                  vipPurchased: true,
                  freeRewarded: new Map(),
                  vipRewarded: new Map()
                }
              });
            } else {
              r.chess7.forEach(function (item) {
                if (item) {
                  if (!item.progressBoardPass) {
                    item.progressBoardPass = {
                      passAid: 40001,
                      activityID: 'progressPass1',
                      rewardTier: '1',
                      vipPurchased: true,
                      freeRewarded: new Map(),
                      vipRewarded: new Map()
                    };
                  } else {
                    item.progressBoardPass.vipPurchased = true;
                  }
                }
              });
            }
          }
          applyChessPBPass(currentRole);
          if (window.d3 && window.d3.role) applyChessPBPass(window.d3.role);

          instantRewards = [
            { itemType: 4, itemId: 0, value: 120 },
            { itemType: 2, itemId: 0, value: 60 }
          ];
          grantCurrency(currentRole, instantRewards);

          setTimeout(function () {
            if (window.w && window.g) window.w.emit(window.g.OnPaySucceed, { goodsIds: [buyItemId.toString()] });
            if (window.WindowManager && window.WindowManager.currentWindow) {
              var cw = window.WindowManager.currentWindow;
              if (cw && typeof cw.refresh === 'function') {
                try { cw.refresh(); } catch (e) {}
              }
            }
          }, 60);

        } else if (isEnergyPassVip) {
          // 能量挑战独立处理
          ensureRoleEnergyPass(currentRole);
          var epData = currentRole.energyPass && currentRole.energyPass.get(20001);
          if (epData) epData.isVip = true;
          if (window.d3 && window.d3.role && window.d3.role.energyPass) {
            var liveEp = window.d3.role.energyPass.get(20001);
            if (liveEp) liveEp.isVip = true;
          }
          instantRewards = [{ itemType: 4, itemId: 0, value: 100 }];
          grantCurrency(currentRole, instantRewards);

          setTimeout(function () {
            if (window.w && window.g) window.w.emit(window.g.OnPaySucceed, { goodsIds: [buyItemId.toString()] });
          }, 60);

        } else {
          // 普通礼包
          instantRewards = [{ itemType: 4, itemId: 0, value: 50 }];
          grantCurrency(currentRole, instantRewards);
          setTimeout(function () {
            if (window.w && window.g) window.w.emit(window.g.OnPaySucceed, { goodsIds: [buyItemId.toString()] });
          }, 60);
        }

        saveNow();

        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              role: currentRole,
              rewards: instantRewards,
              orderInfo: null
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'progressboardpass_reward') {
        var pbRes = applyPBPassReward(currentRole, t.params);
        return Promise.resolve({
          code: pbRes.ok ? 0 : 1,
          error: pbRes.error || '',
          getData: function () {
            return { role: currentRole, rewards: pbRes.rewards || [] };
          },
          rawData: { code: pbRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'progressboardpass_settle') {
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: [] }; },
          rawData: { code: 0 }
        });
      }

      if (currentRole && gcmd === 'pass_reward') {
        var passRes = applyPassReward(currentRole, t.params);
        return Promise.resolve({
          code: passRes.ok ? 0 : 1,
          error: passRes.error || '',
          getData: function () {
            return { role: currentRole, rewards: passRes.rewards || [] };
          },
          rawData: { code: passRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'energypass_passnewreward') {
        var epRes = applyEnergyPassReward(currentRole, t.params, false);
        return Promise.resolve({
          code: epRes.ok ? 0 : 1,
          error: epRes.error || '',
          getData: function () {
            return { role: currentRole, rewards: epRes.rewards || [] };
          },
          rawData: { code: epRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'energypass_claimallreward') {
        var epAllRes = applyEnergyPassReward(currentRole, t.params, true);
        return Promise.resolve({
          code: epAllRes.ok ? 0 : 1,
          error: epAllRes.error || '',
          getData: function () {
            return { role: currentRole, rewards: epAllRes.rewards || [] };
          },
          rawData: { code: epAllRes.ok ? 0 : 1 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'weightrace_start') {
        ensureRoleWeightRace(currentRole);
        var aid = Number(t.params && t.params.aid) || 30001;
        var wr = currentRole.weightRace.get(aid);
        if (wr) wr.state = 1;
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'weightrace_claimendreward') {
        ensureRoleWeightRace(currentRole);
        var wrRewards = [
          { itemType: 2, itemId: 0, value: 50 },  // 50 钻石
          { itemType: 4, itemId: 0, value: 100 }, // 100 体力
          { itemType: 5, itemId: 0, value: 30 }   // 30 加速券
        ];
        grantCurrency(currentRole, wrRewards);
        grantChannelElements(currentRole, wrRewards, 'weightRace');
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: wrRewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'gymsprint_claim') {
        ensureRoleGymSprint(currentRole);
        var aid = Number(t.params && t.params.aid) || 40001;
        var gs = currentRole.gymSprint.get(aid);
        var taskConf = TABLES.gymSprintTask && TABLES.gymSprintTask[gs ? gs.taskId : 1];
        var gsRewards = taskConf ? parseRewardMap(taskConf.reward) : [{ itemType: 4, itemId: 0, value: 30 }];
        if (gs) gs.taskId = (gs.taskId || 1) + 1;
        grantCurrency(currentRole, gsRewards);
        grantChannelElements(currentRole, gsRewards, 'gymSprint');
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: gsRewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'rank_current') {
        var myScoreVal = 888;
        var meObj = { rank: 1, info: { nickname: currentRole.nickname || "店长", score: myScoreVal, avatarUrl: "" } };
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              me: meObj,
              list: [
                meObj,
                { rank: 2, info: { nickname: "室友小鹅A", score: Math.max(100, myScoreVal - 120), avatarUrl: "" } },
                { rank: 3, info: { nickname: "室友小鹅B", score: Math.max(50, myScoreVal - 260), avatarUrl: "" } }
              ]
            };
          },
          rawData: { code: 0 }
        });
      }

      if (currentRole && gcmd === 'rank_actget') {
        var myScoreVal = 888;
        var meObj = { rank: 1, info: { nickname: currentRole.nickname || "店长", score: myScoreVal, avatarUrl: "" } };
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              me: meObj,
              ranks: [
                meObj,
                { rank: 2, info: { nickname: "室友小鹅A", score: Math.max(100, myScoreVal - 120), avatarUrl: "" } },
                { rank: 3, info: { nickname: "室友小鹅B", score: Math.max(50, myScoreVal - 260), avatarUrl: "" } }
              ]
            };
          },
          rawData: { code: 0 }
        });
      }

      if (currentRole && (gcmd === 'rank_currentrankagift' || gcmd === 'rank_reward')) {
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole, rewards: [] }; },
          rawData: { code: 0 }
        });
      }
      
      // ===== 第一部分: 惊喜掉落与自动触发系统 RPC =====

      // 1.1 SurpriseBox
      if (currentRole && gcmd === 'surprisebox_trytrigger') {
        ensureRoleSurpriseBox(currentRole);
        var aid = Number(t.params && t.params.aid) || 50001;
        var sb = currentRole.surpriseBox.get(aid);
        if (sb) {
          sb.episodeId = (sb.episodeId || 0) + 1;
          sb.lastTriggerAt = Math.floor(Date.now() / 1000);
          var activeOrderId = 101;
          if (currentRole.orders && currentRole.orders.length > 0) {
            activeOrderId = currentRole.orders[0].id || 101;
          }
          sb.pendingOrderRewards = [
            { orderId: activeOrderId, rwChestId: 201, rewards: [{ itemType: 4, itemId: 0, value: 30 }] }
          ];
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'surprisebox_claimorderreward') {
        ensureRoleSurpriseBox(currentRole);
        var aid = Number(t.params && t.params.aid) || 50001;
        var orderId = Number(t.params && t.params.orderId) || 0;
        var sb = currentRole.surpriseBox.get(aid);
        var granted = [{ itemType: 4, itemId: 0, value: 30 }, { itemType: 7, itemId: 5004001, value: 1 }];
        if (sb && sb.pendingOrderRewards) {
          sb.pendingOrderRewards = sb.pendingOrderRewards.filter(function (p) { return p.orderId !== orderId; });
        }
        grantChannelElements(currentRole, granted, 'surprisebox');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: granted }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 1.2 DrawerRush
      if (currentRole && gcmd === 'drawerrush_trytrigger') {
        ensureRoleDrawerRush(currentRole);
        var aid = Number(t.params && t.params.aid) || 60001;
        var dr = currentRole.drawerRush.get(aid);
        var now = Math.floor(Date.now() / 1000);
        if (dr) {
          dr.triggered = true;
          dr.currentDrawerId = Number(t.params && t.params.drawerId) || 14;
          dr.windowStartAt = now;
          dr.windowEndAt = now + 3600;
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 1.3 Clover
      if (currentRole && gcmd === 'clover_trytrigger') {
        ensureRoleClover(currentRole);
        var aid = Number(t.params && t.params.aid) || 70001;
        var cl = currentRole.clover.get(aid);
        if (cl) {
          cl.episodeId = (cl.episodeId || 0) + 1;
          if (currentRole.orders && currentRole.orders.length > 0) {
            cl.currentOrderId = currentRole.orders[0].id || 101;
          }
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'clover_tryremarkorder') {
        ensureRoleClover(currentRole);
        var aid = Number(t.params && t.params.aid) || 70001;
        var cl = currentRole.clover.get(aid);
        var markedId = 101;
        if (currentRole.orders && currentRole.orders.length > 0) {
          markedId = currentRole.orders[0].id || 101;
        }
        if (cl) cl.currentOrderId = markedId;
        return Promise.resolve({
          code: 0,
          getData: function () { return { currentOrderId: markedId }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'clover_claimfinalreward') {
        ensureRoleClover(currentRole);
        var aid = Number(t.params && t.params.aid) || 70001;
        var cl = currentRole.clover.get(aid);
        var rewards = [{ itemType: 7, itemId: 5101001, value: 1 }, { itemType: 4, itemId: 0, value: 50 }];
        if (cl) {
          cl.rewardClaimed = true;
          cl.progress = 0;
        }
        grantChannelElements(currentRole, rewards, 'clover_final');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 1.4 SmileBuff
      if (currentRole && gcmd === 'smilebuff_start') {
        ensureRoleSmileBuff(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'smilebuff_getstate') {
        ensureRoleSmileBuff(currentRole);
        var aid = Number(t.params && t.params.aid) || 80001;
        var sb = currentRole.smileBuff.get(aid);
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              currentLevel: sb ? sb.currentLevel : 1,
              score: sb ? sb.score : 0,
              targetScore: sb ? sb.targetScore : 5
            };
          },
          rawData: { code: 0 }
        });
      }

      if (currentRole && gcmd === 'smilebuff_claimreward') {
        ensureRoleSmileBuff(currentRole);
        var rewards = [{ itemType: 4, itemId: 0, value: 20 }];
        grantChannelElements(currentRole, rewards, 'smilebuff');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'smilebuff_consumetarget') {
        ensureRoleSmileBuff(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // ===== 第二部分: 副棋盘与周期性微型小游戏 RPC =====

      // 2.1 Chess7 (7日副棋盘)
      if (currentRole && gcmd === 'chess7_fogunlock') {
        ensureRoleChess7Board(currentRole);
        var aid = Number(t.params && t.params.aid) || 90001;
        var fogId = Number(t.params && t.params.fogId) || 1;
        var c7 = currentRole.chess7.get(aid);
        if (c7 && !c7.unlockedFogs.includes(fogId)) {
          c7.unlockedFogs.push(fogId);
          if (c7.progressBoardKey >= 2) c7.progressBoardKey -= 2;
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { fogId: fogId, unlocked: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'chess7_claimelementreward') {
        ensureRoleChess7Board(currentRole);
        var eleId = Number(t.params && t.params.eleId) || 1;
        var rewards = [{ itemType: 4, itemId: 0, value: 15 }];
        grantChannelElements(currentRole, rewards, 'chess7_element');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'chess7_claimseriesreward') {
        ensureRoleChess7Board(currentRole);
        var rewards = [{ itemType: 2, itemId: 0, value: 50 }];
        grantChannelElements(currentRole, rewards, 'chess7_series');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'chess7_claimwinreward') {
        ensureRoleChess7Board(currentRole);
        var rewards = [{ itemType: 2, itemId: 0, value: 200 }, { itemType: 4, itemId: 0, value: 100 }];
        grantChannelElements(currentRole, rewards, 'chess7_win');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'chess7_claimendreward') {
        ensureRoleChess7Board(currentRole);
        var rewards = [{ itemType: 4, itemId: 0, value: 50 }];
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        });
      }

      if (currentRole && gcmd === 'chess7_recycleboardelements') {
        ensureRoleChess7Board(currentRole);
        return Promise.resolve({
          code: 0,
          getData: function () { return { items: [], indexes: [] }; },
          rawData: { code: 0 }
        });
      }

      // 2.2 DigTreasure (铁锹挖宝大冒险)
      if (currentRole && gcmd === 'digtreasure_getboard') {
        ensureRoleDigTreasure(currentRole);
        var aid = Number(t.params && t.params.aid) || 91001;
        var dg = currentRole.diggame.get(aid);
        return Promise.resolve({
          code: 0,
          getData: function () { return { board: dg ? dg.board : [] }; },
          rawData: { code: 0 }
        });
      }

      if (currentRole && gcmd === 'digtreasure_dig') {
        ensureRoleDigTreasure(currentRole);
        var aid = Number(t.params && t.params.aid) || 91001;
        var idx = Number(t.params && t.params.index) || 0;
        var dg = currentRole.diggame.get(aid);
        if (dg) {
          if (dg.shovelCount > 0) dg.shovelCount--;
          if (dg.board && dg.board[idx]) {
            dg.board[idx][2] = 1; // 标记翻开
          }
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { board: dg ? dg.board : [] }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'digtreasure_orderreward') {
        ensureRoleDigTreasure(currentRole);
        var aid = Number(t.params && t.params.aid) || 91001;
        var rewards = [{ itemType: 7, itemId: 5001001, value: 1 }, { itemType: 4, itemId: 0, value: 40 }];
        var dg = currentRole.diggame.get(aid);
        if (dg) dg.rewardClaimed = true;
        grantChannelElements(currentRole, rewards, 'dig_order_reward');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'digtreasure_startnextlevel') {
        ensureRoleDigTreasure(currentRole);
        var aid = Number(t.params && t.params.aid) || 91001;
        var dg = currentRole.diggame.get(aid);
        if (dg) {
          dg.level = (dg.level || 1) + 1;
          dg.orderID = 101 + dg.level - 1;
          dg.rewardClaimed = false;
          if (Array.isArray(dg.board)) {
            dg.board.forEach(function (cell) { cell[2] = 0; });
          }
        }
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 2.3 BirdToFly (小鸟飞飞)
      if (currentRole && gcmd === 'birdtofly_startstage') {
        ensureRoleBirdToFly(currentRole);
        var aid = Number(t.params && t.params.aid) || 92001;
        var stage = Number(t.params && t.params.stage) || 1;
        var bf = currentRole.birdToFly.get(aid);
        if (bf) bf.stage = stage;
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'birdtofly_claim') {
        ensureRoleBirdToFly(currentRole);
        var aid = Number(t.params && t.params.aid) || 92001;
        var stage = Number(t.params && t.params.stage) || 1;
        var bf = currentRole.birdToFly.get(aid);
        if (bf) bf.claimedStage = stage;
        var rewards = [{ itemType: 5, itemId: 0, value: 10 }, { itemType: 4, itemId: 0, value: 15 }];
        grantChannelElements(currentRole, rewards, 'birdtofly');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 2.4 BumperCar (碰碰车)
      if (currentRole && gcmd === 'bumpercar_start') {
        ensureRoleBumperCar(currentRole);
        var aid = Number(t.params && t.params.aid) || 93001;
        var bc = currentRole.bumperCar.get(aid);
        return Promise.resolve({
          code: 0,
          getData: function () { return { playerDatas: bc ? bc.playerDatas : [] }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'bumpercar_claimreward') {
        ensureRoleBumperCar(currentRole);
        var rewards = [{ itemType: 4, itemId: 0, value: 20 }, { itemType: 7, itemId: 5004001, value: 1 }];
        grantChannelElements(currentRole, rewards, 'bumpercar');
        return Promise.resolve({
          code: 0,
          getData: function () { return { rewards: rewards }; },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      if (currentRole && gcmd === 'cdgift_tryinit') {
        return Promise.resolve({
          code: 0,
          getData: function () { return { role: currentRole }; },
          rawData: { code: 0 }
        });
      }

      // ===== 阶段六：完备拓展业务 RPC 与通用安全兜底 =====
      // 1. 双倍体力充能开关
      if (currentRole && gcmd === 'supercharge_switch') {
        var isSuper = !(currentRole._isSuperChargeOn || false);
        currentRole._isSuperChargeOn = isSuper;
        console.log('[mock-network] 切换双倍充能状态 supercharge_switch:', isSuper);
        return Promise.resolve({
          code: 0,
          getData: function () { return { isSuper: isSuper, role: currentRole }; },
          rawData: { code: 0, isSuper: isSuper }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 2. 迪斯科盲盒活动
      if (currentRole && (gcmd === 'discogift_gacha' || gcmd === 'discogift_settle')) {
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              gotGift: [1, 2],
              rewards: [{ elementId: 1001, count: 2 }],
              role: currentRole
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 3. 翻倍卡包与体力礼包触发
      if (currentRole && (gcmd === 'doublecardpack_trytrigger' || gcmd === 'energygift_tryinit')) {
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true, role: currentRole }; },
          rawData: { code: 0 }
        });
      }

      // 4. 卡牌赛季系统
      if (currentRole && gcmd.startsWith('cardseason_')) {
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              seasonId: 1,
              cards: [],
              rewards: [],
              role: currentRole
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 5. 爬塔玩法
      if (currentRole && gcmd.startsWith('climbtower_')) {
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              curFloor: 1,
              rewards: [{ elementId: 1001, count: 1 }],
              role: currentRole
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 6. 漂流争霸赛
      if (currentRole && gcmd.startsWith('floatrace_')) {
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              rank: 1,
              score: 100,
              rewards: [{ elementId: 1001, count: 2 }],
              role: currentRole
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 7. 养花与外卖送餐活动
      if (currentRole && (gcmd.startsWith('flower_') || gcmd.startsWith('fooddelivery_') || gcmd.startsWith('bigday_'))) {
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              stage: 1,
              joined: true,
              rewards: [{ elementId: 1001, count: 1 }],
              role: currentRole
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 8. 冲刺与对决玩法 (UpgradeRace, FireRank, OneVsOne, OpOGift, MasterMatch, Waterfall)
      if (currentRole && (
        gcmd.startsWith('upgraderace_') ||
        gcmd.startsWith('firerank_') ||
        gcmd.startsWith('onevsone_') ||
        gcmd.startsWith('opogift_') ||
        gcmd.startsWith('mastermatch_') ||
        gcmd.startsWith('waterfall_')
      )) {
        return Promise.resolve({
          code: 0,
          getData: function () {
            return {
              success: true,
              rewards: [{ elementId: 1001, count: 1 }],
              role: currentRole
            };
          },
          rawData: { code: 0 }
        }).then(function (r) { scheduleSave(); return r; });
      }

      // 9. 公共系统与配置 (Common)
      if (currentRole && gcmd.startsWith('common_')) {
        return Promise.resolve({
          code: 0,
          getData: function () { return { success: true, role: currentRole }; },
          rawData: { code: 0 }
        });
      }

      // 10. 好友互助与聊天 (Friend, Inbox, OIM - 用户明确要求取消，静默返回成功空集合)
      if (gcmd.startsWith('friend_') || gcmd.startsWith('inbox_') || gcmd.startsWith('oim_')) {
        return Promise.resolve({
          code: 0,
          getData: function () { return { list: [], count: 0, success: true }; },
          rawData: { code: 0 }
        });
      }
      // 存档注入点:客户端登录(reset 清空 role 后)请求 rolelogin 时,
      //把本地存档还魂进 currentRole,随响应交还给客户端 —— 恢复时机唯一且正确
      if (currentRole && /rolelogin/.test(t && t.cmd || '')) {
        restoreSavedRole(currentRole);
        ensureRoleBoxes(currentRole);
        ensureRoleWeekTask(currentRole);
        ensureRoleMails(currentRole);
      }

      return Promise.resolve({
        code: 0,
        getData: function() {
          var acts = currentRole && currentRole.globalActivity ? Array.from(currentRole.globalActivity.values()) : [];
          return {
            role: currentRole,
            globalActivity: acts,
            cookV2: true,
            mails: currentRole ? (currentRole.mails || []) : [],
            handbook: new Map(),
            list: []
          };
        },
        rawData: {
          code: 0
        }
      }).then(function(r) { scheduleSave(); return r; });
    };

    // 4. 拦截单向广播
    Nu.send = function(t) {
      console.log('[mock-network] send (fire-and-forget):', t && t.cmd || t);
      // 兜底:正常 guidesave 走 sendAsync,这里以防万一 fire-and-forget 也带上进度
      if (t && /guidesave/.test(t.cmd || '')) {
        applyGuideSave((window._user_mgr_ && window._user_mgr_.role), t.params);
      }
      // 兜底:completeorder 正常走 sendAsync,万一走单向上报也记账(幂等)
      if (t && t.cmd === 'game_completeorder') {
        applyCompleteOrder((window._user_mgr_ && window._user_mgr_.role), t.params);
      }
      scheduleSave(); // 单向上报 = 客户端权威状态变更,顺手落盘
    };

    // 5. 确保网络状态标志
    Nu.wsRunning = function() { return true; };
    Nu.isOnline = function() { return true; };
    try {
      Object.defineProperty(Nu, 'isLost', { get: function() { return false; }, configurable: true });
    } catch(e) {}

    // 6. 注入 wsDelegate 保证安全(connected/connectionState 是 getter,须用 installNetState 遮蔽)
    if (Nu.wsDelegate) {
      installNetState(Nu.wsDelegate, Nu);
    }

    // ===== 订单系统:加载原版订单配置 + 调试钩子 =====
    loadOrderConfig();
    loadGameTables();
    window.__buildState = function () {
      var role = window._user_mgr_ && window._user_mgr_.role;
      if (!role || !role.build) return null;
      var b = role.build;
      return {
        coin: role.coin,
        level: role.level, expLevel: role.expLevel,
        diamond: role.diamond,
        areas: b.areas,
        builded: b.builded instanceof Map ? Array.from(b.builded.keys()).sort(function (x, y) { return x - y; }) : [],
        adorns: b.adorns instanceof Map ? Array.from(b.adorns.entries()).map(function (kv) {
          return { id: kv[0], level: kv[1].level, pos: kv[1].cellX + ',' + kv[1].cellY };
        }) : [],
        gooses: role.goose && role.goose.gooses instanceof Map ? Array.from(role.goose.gooses.keys()) : [],
        dayEndTime: role.dayEndTime && new Date(role.dayEndTime).toLocaleString()
      };
    };
    window.__mockBuild = function (buildId) {
      var role = window._user_mgr_ && window._user_mgr_.role;
      var r = applyBuild(role, { buildId: buildId, skinId: 0, cellX: 1, cellY: 1, dir: 0 });
      if (r) saveNow();
      return { result: r, state: window.__buildState() };
    };
    window.__gmNextDay = function () {
      var role = window._user_mgr_ && window._user_mgr_.role;
      if (!role) return 'role 未就绪';
      // 客户端时钟是登录时挂的一次性闹钟(E.addClock),改 dayEndTime 不会提前触发;
      //直接调客户端原生 onDay00Refresh(与自然日界到期同一入口):内部 waitUntilIdle →
      //dayRefresh RPC → 清 daily00Event → emit(DayRefresh) → 重挂钟
      if (typeof window._user_mgr_.onDay00Refresh === 'function') {
        window._user_mgr_.onDay00Refresh();
        return '已调用客户端原生 onDay00Refresh(跨天完整流程)';
      }
      return net.sendAsync({ cmd: 'game_dayrefresh', params: {} }).then(function () {
        return '降级:直发 game_dayrefresh(客户端事件未走全)';
      });
    };
    // 补发指定天数(例如第 6 天)的任务奖励到左上角气泡通道
    window.__gmGrantDayReward = function (day) {
      var role = window._user_mgr_ && window._user_mgr_.role;
      if (!role) return 'role 未就绪';
      var d = Number(day) || 6;
      var os = TABLES.OrderSeries;
      var targetConf = null;
      if (os && os.Main) {
        for (var k in os.Main) {
          if (Number(os.Main[k].orderDay) === d) { targetConf = os.Main[k]; break; }
        }
        if (!targetConf && os.Main[d]) targetConf = os.Main[d];
      }
      if (!targetConf) {
        targetConf = { reward: { '1001103': 1, '1002404': 1, '1004101': 1, '3003002': 1 } };
      }
      var rewards = parseRewardMap(targetConf.reward);
      grantCurrency(role, rewards);
      var added = grantChannelElements(role, rewards, 'gm_day_' + d);
      saveNow();
      var b = getBoardFor(role);
      var chanList = [];
      if (b && b.channel instanceof Map) {
        b.channel.forEach(function (v, k) { chanList.push(k + ' x' + (v.value || 1)); });
      }
      console.log('[GM] 第 ' + d + ' 天奖励已成功发放至左上角气泡通道!', targetConf.reward);
      return {
        ok: true,
        day: d,
        addedElementsCount: added,
        rewardConfig: targetConf.reward,
        currentChannelItems: chanList,
        tip: '刷新页面或进入棋盘，点击左上角气泡即可飞入棋盘！'
      };
    };
    // 一键做菜瞬间完成 (所有正在煮的菜直接完成)
    window.__gmInstantCook = function () {
      var role = window._user_mgr_ && window._user_mgr_.role;
      if (!role) return 'role 未就绪';
      var b = getBoardFor(role);
      if (!b || !b.cells) return '棋盘未就绪';
      var count = 0;
      var now = Date.now();
      b.cells.forEach(function (c) {
        if (c && c.order && c.order.state >= 2) {
          c.order.endTime = now - 1000;
          c.order.state = 3; // complete
          count++;
        }
      });
      saveNow();
      console.log('[GM] 已将 ' + count + ' 道菜品瞬间完成！');
      return { ok: true, completedCookCount: count };
    };
    // ===== 做饭调试钩子 =====
    // 修缮气泡诊断:一键输出金币/解锁链/可建队列/气泡组件状态(排查"手指指向空白")
    window.__diagBuildBubble = function () {
      var role = window._user_mgr_ && window._user_mgr_.role;
      if (!role) return 'role 未就绪';
      var b = role.build;
      var unlocked = [], avail = [];
      var bt = TABLES.Build;
      if (bt) for (var sheet in bt) for (var id in bt[sheet]) {
        var e = bt[sheet][id];
        if (!e) continue;
        if (b.builded instanceof Map && b.builded.get(e.id)) continue;
        var ok = true;
        (e.unlock || []).forEach(function (u) {
          var m = /^(UnlockArea|FinishBuild)(\d+)$/.exec(u);
          if (!m) return;
          if (m[1] === 'UnlockArea' && b.areas.indexOf(Number(m[2])) < 0) ok = false;
          if (m[1] === 'FinishBuild' && !(b.builded instanceof Map && b.builded.get(Number(m[2])))) ok = false;
        });
        if (!ok) continue;
        unlocked.push(e.id);
        var price = Number((e.demand || {}).Coin) || 0;
        if ((role.coin || 0) >= price) avail.push(e.id);
      }
      var comp = null;
      var walk = function (n, d) {
        if (!n || d > 12 || comp) return;
        var c = n.getComponent && (n.getComponent('MergeQueueBuildView') || n.getComponent('MergeBuildView') || n.getComponent('MergeQueueBuildViewBase'));
        if (c && c.updateView) { comp = c; return; }
        (n.children || []).forEach(function (ch) { walk(ch, d + 1); });
      };
      try { walk(cc.find('Canvas'), 0); } catch (err) {}
      var board = getBoardFor(role);
      return {
        coin: role.coin,
        builded: b.builded instanceof Map ? Array.from(b.builded.keys()) : [],
        areas: b.areas,
        unlocked: unlocked.slice(0, 10),
        available: avail.slice(0, 10),
        bubble: comp ? { hasAvail: comp._hasAvailable, isShow: comp.isShow } : '未找到(不在棋盘界面?)',
        drawer: board ? board.orderDrawerEndId : null,
        activeOrders: board && board.orders instanceof Map ? Array.from(board.orders.keys()).slice(0, 5) : []
      };
    };
    window.__cookState = function (index) {
      var role = window._user_mgr_ && window._user_mgr_.role;
      var b = getBoardFor(role);
      if (!b) return null;
      var cell = b.cells.get(index);
      if (!cell) return '无 cell ' + index;
      var o = cell.order || {};
      return {
        index: index, elementId: cell.elementId,
        orderId: o.orderId || 0, state: o.state || 0,
        endTime: o.endTime ? new Date(o.endTime).toLocaleTimeString() : 0,
        elements: o.elements instanceof Map ? Array.from(o.elements.entries()) : [],
        pocket: (cell.hiddenPocket || []).map(function (p) { return p.elementId; })
      };
    };
    // 测试助手:往 index 放炊具/投料(绕过渲染层,直接操作活体 role + 走真实 RPC 管线)
    window.__mockCookCell = function (index, cookwareElemId) {
      var role = window._user_mgr_ && window._user_mgr_.role;
      var b = getBoardFor(role);
      var cell = b.cells.get(index);
      if (!cell) return '无 cell';
      cell.elementId = cookwareElemId;
      cell.state = 0;
      return window.__cookState(index);
    };
    window.__mockCookPut = function (index, ingredientId) {
      return window.net.sendAsync({ cmd: 'game_cookputingredients', params: { boardId: 1, index: index, indexes: [], ingredientId: ingredientId, timestamp: Date.now() } }).then(function () {
        return window.__cookState(index);
      });
    };
    window.__mockCookStart = function (index) {
      return window.net.sendAsync({ cmd: 'game_cookstart', params: { boardId: 1, index: index, timestamp: Date.now() } }).then(function (r) {
        var d = r.getData();
        var c = d.cells && d.cells[0];
        return { code: r.code, respOrder: c && c.order ? { orderId: c.order.orderId, state: c.order.state, endTime: c.order.endTime } : null, state: window.__cookState(index) };
      });
    };
    window.__orderState = function () {
      var role = window._user_mgr_ && window._user_mgr_.role;
      var b = getBoardFor(role);
      if (!b) return null;
      return {
        orderDrawerEndId: b.orderDrawerEndId || 0,
        ordered: b.ordered instanceof Map ? Array.from(b.ordered.keys()) : [],
        orders: b.orders instanceof Map ? Array.from(b.orders.entries()).map(function (kv) {
          return { key: kv[0], id: kv[1].id, orderId: kv[1].orderId, demand: Array.from(kv[1].demand.entries()) };
        }) : []
      };
    };
    window.__mockCompleteOrder = function (orderId) {
      var role = window._user_mgr_ && window._user_mgr_.role;
      applyCompleteOrder(role, { orderId: orderId, boardId: 1, timestamp: Date.now() });
      saveNow();
      return window.__orderState();
    };
    window.__bagState = function () {
      var role = window._user_mgr_ && window._user_mgr_.role;
      var b = getBoardFor(role);
      if (!b || !b.bag) return null;
      var items = [];
      if (b.bag.items instanceof Map) {
        b.bag.items.forEach(function (v, k) {
          items.push({ bagId: k, elementId: v.elementId, state: v.state });
        });
      }
      return {
        size: b.bag.size || 8,
        extSize: b.bag.extSize || 0,
        count: b.bag.items ? b.bag.items.size : 0,
        items: items
      };
    };
    window.__launcherBagState = function () {
      var role = window._user_mgr_ && window._user_mgr_.role;
      if (!role || !role.launcherBag) return null;
      var handbook = [];
      if (role.launcherBag.handbook instanceof Map) {
        handbook = Array.from(role.launcherBag.handbook.keys());
      }
      var items = [];
      if (role.launcherBag.items instanceof Map) {
        role.launcherBag.items.forEach(function (v, k) {
          items.push({ launcherId: k, elementId: v.elementId, state: v.state });
        });
      }
      return {
        handbook: handbook,
        items: items
      };
    };
    console.log('[mock-network] Orange 框架网络层 mock 完成！');
  }

  // 监听 window.net 注入
  Object.defineProperty(window, 'net', {
    configurable: true,
    enumerable: true,
    get: function() { return _net; },
    set: function(v) {
      _net = v;
      setupNet(_net);
    }
  });

  // 监听 window._user_mgr_ 注入
  Object.defineProperty(window, '_user_mgr_', {
    configurable: true,
    enumerable: true,
    get: function() { return _user_mgr; },
    set: function(v) {
      _user_mgr = v;
      if (_user_mgr && _user_mgr.role) {
        initRole(_user_mgr.role);
      }
      // 给 UserMgr 本体装 role 赋值陷阱(reset() 重造的 role 也会被规整)
      if (_user_mgr && _user_mgr !== window) hardenRoleProperty(_user_mgr);
    }
  });

  window.__initRole = initRole;
  window.getBuildInfo = function () {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "No role";
    var b = role.build;
    return {
      金币: role.coin,
      已建1022: b.builded ? b.builded.get(1022) : false,
      已建1023: b.builded ? b.builded.get(1023) : false,
      已建1024: b.builded ? b.builded.get(1024) : false,
      已建1025: b.builded ? b.builded.get(1025) : false,
      轻食小站状态: b.adorns ? b.adorns.get(100011) : null
    };
  };

  // GM 自由发道具/发射器工具: 例如 giveItem(3003003) 发榨汁杯
  window.giveItem = function (elemId, count) {
    elemId = Number(elemId) || 3003003;
    count = Number(count) || 1;
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "未找到角色数据";
    var rw = [{ itemType: 7, itemId: elemId, value: count }];
    grantChannelElements(role, rw, 'gm_give');
    try {
      if (window.d3 && window.d3.role && window.d3.role !== role) {
        grantChannelElements(window.d3.role, rw, 'gm_give');
      }
    } catch (e) {}
    try {
      if (typeof window.w !== 'undefined' && window.g && window.g.RefreshChannel) {
        window.w.emit(window.g.RefreshChannel);
      }
    } catch (e) {}
    saveNow();
    return "已成功发放物品 ID " + elemId + " x" + count + " 至棋盘通道！进入棋盘点击左下角待领气泡即可飞入。";
  };

  // GM 自由打开 WeekTask 和 ImgBox 窗口工具
  window.openWeekTask = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1186, { aid: 101 });
        return "✅ 已打开周任务 / 日常任务窗口！";
      } catch (e) {
        return "打开周任务窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.openAvatarWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1071);
        return "✅ 已打开店长装扮 / 形象 / 宠物相册窗口！";
      } catch (e) {
        return "打开店长装扮窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.openBadgeWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1073);
        return "✅ 已打开成就徽章墙窗口！";
      } catch (e) {
        return "打开成就徽章墙窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.openPlayerHeadWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1075);
        return "✅ 已打开店长个人名片窗口！";
      } catch (e) {
        return "打开店长名片窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.openMailWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1049);
        return "✅ 已打开系统信箱窗口！";
      } catch (e) {
        return "打开系统信箱失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  // GM 自由发邮件工具
  window.sendMail = function (options) {
    options = options || {};
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "未找到角色数据";
    ensureRoleMails(role);
    var newId = (role.mails.length ? Math.max.apply(null, role.mails.map(function(m) { return Number(m.id) || 0; })) : 10000) + 1;
    var mail = {
      id: newId,
      title: options.title || "系统专属测试福利",
      from: options.from || "肥鹅运营组",
      content: JSON.stringify({ isnotice: options.isNotice ? "1" : "0", desc: options.content || "感谢参与内测！这是特意为您送上的测试补给物资，祝您游戏愉快！" }),
      createAt: Math.floor(Date.now() / 1000),
      expireAt: Math.floor(Date.now() / 1000) + (options.expireDays || 30) * 86400,
      state: 1, // yr.newMail = 1
      haveAttachments: Boolean(options.rewards && options.rewards.length),
      rewards: options.rewards || [
        { itemType: 1, itemId: 0, value: 3000 }, // 3000 金币
        { itemType: 4, itemId: 0, value: 100 },  // 100 体力
        { itemType: 2, itemId: 0, value: 100 }   // 100 钻石
      ]
    };
    role.mails.unshift(mail);
    role.mailNewCount = (role.mailNewCount || 0) + 1;
    try {
      if (window.w && window.g && window.g.Mail_Load) window.w.emit(window.g.Mail_Load);
    } catch(e) {}
    saveNow();
    return "✅ 成功向邮箱发送邮件 [ID: " + newId + "]：" + mail.title + " (含 " + mail.rewards.length + " 个附件)。打开信箱即可领取！";
  };

  // 周期性确保周任务棋盘入口解锁
  function hookWeekTaskEntranceUnlock() {
    if (window.config && window.config.WeekTaskActivity) {
      try {
        var wt1 = window.config.WeekTaskActivity.getById('wt1');
        if (wt1 && wt1.unlock && wt1.unlock.length > 0) wt1.unlock = [];
      } catch (e) {}
    }
  }
  setInterval(hookWeekTaskEntranceUnlock, 1000);

  // 彻底关闭并隐藏微信订阅体系 (禁用 WxSubscribe 并在界面中完全隐藏菜单项与红点，杜绝 NeverUnlock 配置错误)
  function disableSubscribeSystem() {
    try {
      if (window.config && window.config.Unlock) {
        var u = window.config.Unlock.getById("WxSubscribe");
        if (u && (!u.condition || u.condition.includes("NeverUnlock") || u.condition.length > 0)) {
          u.condition = ["PlayerLevel999"]; // 使用标准的有效条件，杜绝 ParseItemConf 异常
        }
      }
      if (window.dB) {
        window.dB.isUnlockSubscribeWindow = function () { return false; };
        window.dB.canForcePopupNow = function () { return false; };
        window.dB.checkRedDot = function () { return false; };
      }
      var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
      if (role) {
        if (!role.weChatSubscription) role.weChatSubscription = { subscribed: new Map() };
        if (role.weChatSubscription.subscribed instanceof Map) {
          role.weChatSubscription.subscribed.set(1, true);
          role.weChatSubscription.subscribed.set(2, true);
          role.weChatSubscription.subscribed.set(3, true);
        }
      }
    } catch (e) {}
  }
  setInterval(disableSubscribeSystem, 1000);

  window.openSettingWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1047);
        return "✅ 已打开游戏设置窗口！";
      } catch (e) {
        return "打开设置窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.openNewPlayerGift = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1212);
        return "✅ 已打开新手成长礼包窗口！";
      } catch (e) {
        return "打开新手成长礼包失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.openNewbieGift = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1109);
        return "✅ 已打开新手福利大礼包窗口！";
      } catch (e) {
        return "打开新手福利大礼包失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  // ===== 阶段五 GM 调试指令 =====

  window.openPassWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1117, { aid: 10001 });
        return "✅ 已打开赛季通行证 (Pass) 窗口！";
      } catch (e) {
        return "打开通行证窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.addPassPoints = function (count) {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "❌ 未找到角色数据";
    count = Number(count) || 100;
    addPassPoints(role, count);
    saveNow();
    return "✅ 成功为通行证增加 " + count + " 积分！当前积分: " + (role.pass && role.pass.get(10001) ? role.pass.get(10001).passPoint : 0);
  };

  window.unlockSVIP = function () {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "❌ 未找到角色数据";
    ensureRolePass(role);
    var pData = role.pass && role.pass.get(10001);
    if (pData) {
      pData.status = 2; // SVIP 高级会员
      pData.passPoint = Math.max(pData.passPoint || 0, 20); // 赠送 10 级进度 (20点积分)
      if (window.d3 && window.d3.role && window.d3.role.pass) {
        var liveP = window.d3.role.pass.get(10001);
        if (liveP) {
          liveP.status = 2;
          liveP.passPoint = pData.passPoint;
        }
      }
      saveNow();
      if (window.w && window.g) {
        window.w.emit(window.g.OnPaySucceed, { goodsIds: ['10010102'] });
        window.w.emit(window.g.PassVipUnlocked, { aid: 10001 });
        window.w.emit(window.g.PassSvipUnlocked, { aid: 10001 });
        window.w.emit(window.g.PassVipUpgrade, { aid: 10001 });
      }
      if (window.PassWindow) {
        try {
          if (typeof window.PassWindow.renderButton === 'function') window.PassWindow.renderButton();
          if (window.PassWindow.activity && typeof window.PassWindow.render === 'function') {
            var pnt = window.PassWindow.activity.readLastAnimatedPoint();
            window.PassWindow.render(pnt);
          }
          if (window.PassWindow.layoutPassTask && window.PassWindow.layoutPassTask.node) {
            var items = window.PassWindow.layoutPassTask.node.getComponentsInChildren('ZEe') || [];
            items.forEach(function (it) {
              if (it && typeof it.vipUnlockAnim === 'function') it.vipUnlockAnim();
            });
          }
        } catch (e) {}
      }
      return "🎉 成功！通行证已升级为【高级会员 (SVIP)】，并立即到账 10 级进度 (当前点数: " + pData.passPoint + ")！VIP奖励已全量解锁可领！";
    }
    return "❌ 通行证数据不存在";
  };

  
  // ===== 扩展模块 GM 控制台调试与测试工具 =====
  function getLiveRole() {
    return (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
  }

  window.unlockPart1 = function () {
    var role = getLiveRole();
    if (!role) return console.warn('liveRole 为空');
    ensureRoleSurpriseBox(role);
    ensureRoleDrawerRush(role);
    ensureRoleClover(role);
    ensureRoleSmileBuff(role);
    console.log('✅ 第一部分四大机制（惊喜盒子、抽屉冲刺、四叶草、火热做菜）已全部激活！');
  };

  window.unlockPart2 = function () {
    var role = getLiveRole();
    if (!role) return console.warn('liveRole 为空');
    ensureRoleChess7Board(role);
    ensureRoleDigTreasure(role);
    ensureRoleBirdToFly(role);
    ensureRoleBumperCar(role);
    console.log('✅ 第二部分四大玩法（7日副棋盘、挖宝大冒险、小鸟飞飞、碰碰车）已全部激活！');
  };

  window.triggerSurpriseBox = function () {
    var role = getLiveRole();
    if (!role) return console.warn('liveRole 为空');
    ensureRoleSurpriseBox(role);
    var sb = role.surpriseBox.get(50001);
    if (sb) {
      sb.episodeId = (sb.episodeId || 0) + 1;
      var activeOrderId = 101;
      if (role.orders && role.orders.length > 0) activeOrderId = role.orders[0].id || 101;
      sb.pendingOrderRewards = [
        { orderId: activeOrderId, rwChestId: 201, rewards: [{ itemType: 4, itemId: 0, value: 50 }] }
      ];
      console.log('🎉 惊喜盒子盲盒已挂载至订单 #' + activeOrderId + '！提交订单即可开启！');
    }
  };

  window.addShovels = function (count) {
    var role = getLiveRole();
    if (!role) return console.warn('liveRole 为空');
    ensureRoleDigTreasure(role);
    var dg = role.diggame.get(91001);
    if (dg) {
      dg.shovelCount = (dg.shovelCount || 0) + (Number(count) || 10);
      console.log('⛏️ 铁锹已增加 +' + (count || 10) + '，当前剩余: ' + dg.shovelCount);
    }
  };

  window.checkActivitiesStatus = function () {
    var role = getLiveRole();
    if (!role) return console.warn('liveRole 为空');
    var acts = role.globalActivity ? Array.from(role.globalActivity.values()) : [];
    console.table(acts.map(function (a) {
      return { id: a.id, typeId: a.typeId, content: a.content, status: '运行中' };
    }));
  };

  
  // 一键直达打开扩展活动与玩法窗口
  function safeOpenWin(winId, params) {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (!wm) {
      console.warn("❌ 窗口管理器未就绪，请等待主界面加载完成后再试");
      return false;
    }
    try {
      wm.showWindow(winId, params || {});
      return true;
    } catch (e) {
      console.error("打开窗口失败 (" + winId + "):", e);
      return false;
    }
  }

  window.openDigGame = function () {
    window.unlockPart2();
    safeOpenWin(1087, { aid: 91001 });
    console.log("⛏️ 铁锹挖宝大冒险窗口已弹出！使用 addShovels(10) 可随时加铁锹。");
  };

  window.openBirdToFly = function () {
    window.unlockPart2();
    safeOpenWin(1223, { aid: 92001 });
    console.log("🐦 小鸟飞飞限时活动窗口已弹出！");
  };

  window.openBumperCar = function () {
    window.unlockPart2();
    safeOpenWin(1218, { aid: 93001 });
    console.log("🚗 碰碰车对抗赛活动窗口已弹出！");
  };

  window.openProgressBoard = function () {
    window.unlockPart2();
    safeOpenWin(1154, { aid: 90001 });
    console.log("🗺️ 7日副棋盘 (ProgressBoard) 窗口已弹出！");
  };

  window.openClover = function () {
    window.unlockPart1();
    safeOpenWin(1129, { aid: 70001 });
    console.log("🍀 四叶草幸运收集窗口已弹出！");
  };

  window.openDrawerRush = function () {
    window.unlockPart1();
    safeOpenWin(1153, { aid: 60001 });
    console.log("⏱️ 限时抽屉冲刺活动窗口已弹出！");
  };

  window.openSmileBuff = function () {
    window.unlockPart1();
    safeOpenWin(1194, { aid: 80001 });
    console.log("🔥 火热做菜加速 Buff 窗口已弹出！");
  };

  window.openSurpriseBox = function () {
    window.unlockPart1();
    safeOpenWin(1125, { aid: 50001 });
    console.log("🎁 惊喜礼盒活动开始弹窗已弹出！");
  };
  
  window.checkVIP = function () {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) {
      console.error('❌ 未找到角色数据！游戏可能尚未完全加载就绪。');
      return null;
    }

    var report = {
      roleId: role.roleId,
      pass: null,
      chessPBPass: [],
      energyPass: null,
      currentWindow: null
    };

    if (role.pass && role.pass.get) {
      var p = role.pass.get(10001);
      if (p) {
        var statusDesc = '普通免费版 (0)';
        if (p.status === 1) statusDesc = '进阶版 VIP (1)';
        else if (p.status === 2) statusDesc = '荣耀版 SVIP (2)';
        report.pass = {
          status: p.status,
          statusDesc: statusDesc,
          passPoint: p.passPoint,
          isVIP: p.status >= 1
        };
      }
    }

    if (role.chess7 && typeof role.chess7.forEach === 'function') {
      role.chess7.forEach(function (val, key) {
        if (val && val.progressBoardPass) {
          var pb = val.progressBoardPass;
          report.chessPBPass.push({
            boardId: key,
            passAid: pb.passAid,
            activityID: pb.activityID,
            rewardTier: pb.rewardTier,
            vipPurchased: pb.vipPurchased,
            isVIP: Boolean(pb.vipPurchased)
          });
        }
      });
    }

    if (role.energyPass && role.energyPass.get) {
      var ep = role.energyPass.get(20001);
      if (ep) {
        report.energyPass = {
          isVip: ep.isVip,
          point: ep.point
        };
      }
    }

    if (window.WindowManager) {
      try {
        var td = window.WindowManager.topWindowData;
        report.currentWindow = {
          windowId: window.WindowManager.currentWindow,
          name: td ? td.Name : 'none'
        };
      } catch (e) {}
    }

    console.log('[VIP状态报告]', report);
    return report;
  };

  window.forceBecomeVIP = function () {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return '❌ 角色未就绪';

    // 1. 通行证强开 SVIP
    ensureRolePass(role);
    var p = role.pass.get(10001);
    if (p) p.status = 2;
    if (window.d3 && window.d3.role && window.d3.role.pass) {
      var lp = window.d3.role.pass.get(10001);
      if (lp) lp.status = 2;
    }

    // 2. 棋盘通行证强开高级会员
    if (role.chess7 && typeof role.chess7.forEach === 'function') {
      role.chess7.forEach(function (item) {
        if (item && item.progressBoardPass) item.progressBoardPass.vipPurchased = true;
      });
    }
    if (window.d3 && window.d3.role && window.d3.role.chess7 && typeof window.d3.role.chess7.forEach === 'function') {
      window.d3.role.chess7.forEach(function (item) {
        if (item && item.progressBoardPass) item.progressBoardPass.vipPurchased = true;
      });
    }

    // 3. 能量挑战强开 VIP
    ensureRoleEnergyPass(role);
    var ep = role.energyPass.get(20001);
    if (ep) ep.isVip = true;
    if (window.d3 && window.d3.role && window.d3.role.energyPass) {
      var lep = window.d3.role.energyPass.get(20001);
      if (lep) lep.isVip = true;
    }

    saveNow();

    // 4. 派发全局通知并强刷所有窗口
    if (window.w && window.g) {
      window.w.emit(window.g.OnPaySucceed, { goodsIds: ['10010101', '10010102', '9950101', '991001'] });
      window.w.emit(window.g.PassVipUnlocked, { aid: 10001 });
      window.w.emit(window.g.PassSvipUnlocked, { aid: 10001 });
      window.w.emit(window.g.PassVipUpgrade, { aid: 10001 });
    }

    if (window.PassWindow) {
      try {
        window.PassWindow.renderButton();
        var pnt = window.PassWindow.activity.readLastAnimatedPoint();
        window.PassWindow.render(pnt);
        if (window.PassWindow.layoutPassTask && window.PassWindow.layoutPassTask.node) {
          var items = window.PassWindow.layoutPassTask.node.getComponentsInChildren('ZEe') || [];
          items.forEach(function (it) {
            if (it && typeof it.vipUnlockAnim === 'function') it.vipUnlockAnim();
          });
        }
      } catch (e) {}
    }

    if (window.WindowManager && window.WindowManager.currentWindow) {
      var cw = window.WindowManager.currentWindow;
      if (cw && typeof cw.refresh === 'function') {
        try { cw.refresh(); } catch (e) {}
      }
    }

    return '🎉 成功！全体系 VIP / SVIP / 高级会员特权已强制开启，已落盘保存！';
  };

  window.unlockPBPassVIP = function () {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "❌ 未找到角色数据";
    if (role.chess7 && typeof role.chess7.forEach === 'function') {
      role.chess7.forEach(function (item) {
        if (item && item.progressBoardPass) item.progressBoardPass.vipPurchased = true;
      });
    }
    saveNow();
    if (window.WindowManager && window.WindowManager.currentWindow) {
      try { window.WindowManager.currentWindow.refresh(); } catch (e) {}
    }
    return "✅ 已成功开通棋盘通行证 (PBPass) 高级会员！";
  };

  window.unlockEnergyPassVIP = function () {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "❌ 未找到角色数据";
    ensureRoleEnergyPass(role);
    var ep = role.energyPass && role.energyPass.get(20001);
    if (ep) ep.isVip = true;
    if (window.d3 && window.d3.role && window.d3.role.energyPass) {
      var liveEp = window.d3.role.energyPass.get(20001);
      if (liveEp) liveEp.isVip = true;
    }
    saveNow();
    return "✅ 已成功开通能量挑战 (EnergyPass) 进阶版特权！";
  };

  window.unlockAllVIP = function () {
    window.unlockPassVIP(2);
    window.unlockPBPassVIP();
    window.unlockEnergyPassVIP();
    return "🎉 已一键解锁全游戏所有 VIP 与高级会员特权！";
  };

  window.unlockPassVIP = function (level) {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "❌ 未找到角色数据";
    ensureRolePass(role);
    var pData = role.pass && role.pass.get(10001);
    if (pData) {
      pData.status = Number(level) || 2; // 1: VIP, 2: SVIP
      saveNow();
      return "✅ 已成功升级通行证身份为: " + (pData.status === 2 ? "SVIP (荣耀通行证)" : "VIP (进阶通行证)") + "！";
    }
    return "❌ 通行证数据不存在";
  };

  window.openEnergyPassWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1126, { aid: 20001 });
        return "✅ 已打开能量挑战 (EnergyPass) 窗口！";
      } catch (e) {
        return "打开能量挑战窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.addEnergyPassPoints = function (count) {
    var role = (window.d3 && window.d3.role) || (window._user_mgr_ && window._user_mgr_.role);
    if (!role) return "❌ 未找到角色数据";
    count = Number(count) || 500;
    addEnergyPassPoints(role, count);
    saveNow();
    return "✅ 成功为能量挑战增加 " + count + " 消耗点数！当前点数: " + (role.energyPass && role.energyPass.get(20001) ? role.energyPass.get(20001).point : 0);
  };

  window.openWeightRaceWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1095, { aid: 30001 });
        return "✅ 已打开体重争霸赛窗口！";
      } catch (e) {
        return "打开争霸赛窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  window.openGymSprintWindow = function () {
    var wm = window.WindowManager || (window.l3 && window.l3.showWindow && window.l3);
    if (wm) {
      try {
        wm.showWindow(1115, { aid: 40001 });
        return "✅ 已打开运动冲刺 (GymSprint) 窗口！";
      } catch (e) {
        return "打开冲刺窗口失败: " + e.message;
      }
    }
    return "❌ 窗口管理器未就绪，请先等待主界面加载完成";
  };

  // ===== 画面去噪纯净化：彻底消除肥鹅身上、修缮建筑以及棋盘上的 debug 元素编号 =====
  function installDebugDisplaySanitizer() {
    var isDebugNode = function (n) {
      if (!n) return false;
      var str = String(n).toLowerCase();
      return str.includes('debug') || str === 'idlabel' || str === 'help' || str.includes('labeldebug');
    };

    var cleanNode = function (node) {
      if (!node) return;
      if (node.name && isDebugNode(node.name)) {
        node.active = false;
        node.opacity = 0;
        var lbl = node.getComponent && node.getComponent(cc.Label);
        if (lbl) {
          lbl.string = '';
        }
      }
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
          cleanNode(node.children[i]);
        }
      }
    };

    // ===== 详情说明与对话字体智能高清放大增强 =====
    var isTargetNode = function (node) {
      if (!node || !node.name) return false;
      var n = node.name.toLowerCase();
      if (n.includes('desc') || n.includes('explain') || n.includes('info') || n.includes('dialogue') ||
          n.includes('narrative') || n.includes('talk') || n.includes('bubble') || n.includes('content') ||
          n === 'label_from' || n === 'label_special') {
        return true;
      }
      var p = node.parent;
      while (p) {
        var pn = p.name ? p.name.toLowerCase() : '';
        if (pn.includes('elementinfo') || pn.includes('elementdetail') || pn.includes('narrative') ||
            pn.includes('guidetalk') || pn.includes('dialogue') || pn.includes('bubble')) {
          return true;
        }
        p = p.parent;
      }
      return false;
    };

    var boostLabel = function (lbl) {
      if (!lbl || !lbl.node || !lbl.node.name) return;
      var n = lbl.node.name.toLowerCase();
      var str = lbl.string ? String(lbl.string) : '';
      var hasChinese = /[\u4e00-\u9fa5]/.test(str);

      if (n === 'label_info' || n === 'name') {
        if (lbl.fontSize < 36) {
          lbl.fontSize = 36;
          lbl.lineHeight = 40;
        }
      } else if (n.includes('desc') || n.includes('explain')) {
        if (lbl.fontSize < 28) {
          lbl.fontSize = 28;
          lbl.lineHeight = 34;
        }
        lbl.overflow = cc.Label.Overflow.RESIZE_HEIGHT;
        lbl.enableWrapText = true;
      } else if (hasChinese && str.length >= 4) {
        // 通用剧情对话、气泡说明、任务提示文字保底
        if (lbl.fontSize < 26) {
          lbl.fontSize = 26;
          lbl.lineHeight = Math.max(lbl.lineHeight, 32);
        }
      }
    };

    // 1. 拦截 cc.Label.prototype.string 与 onLoad，彻底净化 Debug 标签并增强字体
    function hookLabel() {
      if (typeof cc === 'undefined' || !cc.Label || !cc.Label.prototype) return false;

      // 文本防萎缩保底：防止 SHRINK 模式把文字暴力压缩成看不清的微缩字
      if (cc.Label.prototype._calculateShrinkFont && !cc.Label.prototype.__origCalculateShrinkFont) {
        cc.Label.prototype.__origCalculateShrinkFont = cc.Label.prototype._calculateShrinkFont;
        cc.Label.prototype._calculateShrinkFont = function (str) {
          var res = this.__origCalculateShrinkFont(str);
          var minSize = Math.max(Math.floor(this.fontSize * 0.75), 24);
          if (this.actualFontSize < minSize) {
            this.actualFontSize = minSize;
          }
          return res;
        };
      }

      var origStringDesc = Object.getOwnPropertyDescriptor(cc.Label.prototype, 'string');
      if (origStringDesc && origStringDesc.set && !cc.Label.prototype.__debugHooked) {
        cc.Label.prototype.__debugHooked = true;
        Object.defineProperty(cc.Label.prototype, 'string', {
          get: origStringDesc.get,
          set: function (val) {
            if (this.node && this.node.name && isDebugNode(this.node.name)) {
              this.node.active = false;
              this.node.opacity = 0;
              return origStringDesc.set.call(this, '');
            }
            var ret = origStringDesc.set.call(this, val);
            if (this.node && isTargetNode(this.node)) {
              boostLabel(this);
            }
            return ret;
          },
          configurable: true
        });
      }

      // 针对 ElementInfo 与 ElementDetailWindow 原型注入
      try {
        var elInfoCls = cc.js && cc.js.getClassByName && cc.js.getClassByName('ElementInfo');
        if (elInfoCls && elInfoCls.prototype && !elInfoCls.prototype.__boostHooked) {
          elInfoCls.prototype.__boostHooked = true;
          var origShowInfo = elInfoCls.prototype.showElementInfo;
          elInfoCls.prototype.showElementInfo = function (e, t) {
            var res = origShowInfo.apply(this, arguments);
            try {
              if (this.label_info) {
                this.label_info.fontSize = 38;
                this.label_info.lineHeight = 42;
              }
              if (this.label_desc) {
                this.label_desc.fontSize = 28;
                this.label_desc.lineHeight = 34;
                this.label_desc.overflow = cc.Label.Overflow.RESIZE_HEIGHT;
                this.label_desc.enableWrapText = true;
              }
            } catch (err) {}
            return res;
          };
        }
      } catch (e) {}

      return true;
    }

    // 专属保障：肥鹅原版 GM 工具精简与美化（带定时轮询与点击小箭头拦截双保险）
    function applyExtraGmToolHook() {
      if (typeof cc === 'undefined' || !cc.js || !cc.js.getClassByName) return false;

      var extraGmCls = cc.js.getClassByName('ExtraGmTool');
      if (!extraGmCls || !extraGmCls.prototype) return false;

      if (!extraGmCls.prototype.__accountHooked) {
        extraGmCls.prototype.__accountHooked = true;

        // 1. 放大按钮字号
        var extraBtnCls = cc.js.getClassByName('ExtraGmBtn');
        if (extraBtnCls && extraBtnCls.prototype && !extraBtnCls.prototype.__boostHooked) {
          extraBtnCls.prototype.__boostHooked = true;
          var origOnData = extraBtnCls.prototype.onData;
          extraBtnCls.prototype.onData = function () {
            origOnData.apply(this, arguments);
            var lbl = this.node && this.node.getComponentInChildren(cc.Label);
            if (lbl) {
              lbl.fontSize = 22;
              lbl.lineHeight = 26;
            }
          };
        }

        // 2. 彻底拦截 ExtraGmTool 列表渲染，只展示 5 个极简核心功能，并隐藏冗余输入框
        extraGmCls.prototype.initGmList = function () {
          try {
            // 隐藏上方的搜索框、对象ID、值、翻页按钮等全部冗余控件
            var contentNode = this.node && this.node.parent;
            if (contentNode) {
              ['idEdit', 'countEdit', 'search', 'searchBtn', 'searchClearBtn', 'searchHistoryUpBtn', 'searchHistoryDownBtn', 'paramHistoryUpBtn', 'paramHistoryDownBtn', 'debug'].forEach(function (name) {
                var child = contentNode.getChildByName(name);
                if (child) child.active = false;
              });

              // 调整标题 Title
              var titleNode = contentNode.getChildByName('Title');
              if (titleNode) {
                titleNode.y = 120;
                var tLbl = titleNode.getComponent(cc.Label);
                if (tLbl) { tLbl.string = '快捷调试'; tLbl.fontSize = 22; }
              }

              // 调整背景尺寸为小巧紧凑卡片
              var bgNode = contentNode.getChildByName('bg');
              if (bgNode) {
                bgNode.width = 380;
                bgNode.height = 320;
                bgNode.y = 0;
              }
              contentNode.height = 320;
              if (contentNode.parent) {
                contentNode.parent.height = 320; // root
              }
            }

            if (this.node) {
              this.node.y = 90; // 上移紧贴标题
              this.node.height = 240;
            }
            if (this.list && this.list.node) {
              this.list.node.height = 240;
              if (this.list.node.parent) this.list.node.parent.height = 240;
            }
          } catch (err) {}

          var role = window._user_mgr_ && window._user_mgr_.role;

          // 仅保留用户指定的 5 个核心功能
          var customTools = [
            {
              name: '切换账号',
              flag: '账号',
              level: 9999,
              color: cc.v3(245, 158, 11), // 温暖琥珀橙
              helpText: '点击输入目标 UID，快速切换账号',
              func: function () {
                var currentUid = new URL(location.href).searchParams.get('uid') || '1001';
                var targetUid = prompt('请输入要切换的目标账号 UID (例如 1002):', currentUid);
                if (targetUid === null) return;
                targetUid = targetUid.trim();
                if (!targetUid) return;
                var url = new URL(location.href);
                url.searchParams.set('uid', targetUid);
                location.href = url.toString();
              }
            },
            {
              name: '修改昵称',
              flag: '账号',
              level: 9998,
              color: cc.v3(59, 130, 246), // 亮蓝
              helpText: '点击输入新昵称并保存生效',
              func: function () {
                var curName = (role && role.name) || '肥鹅馆长';
                var newName = prompt('请输入新的角色昵称:', curName);
                if (newName === null) return;
                newName = newName.trim();
                if (!newName) return;
                if (role) {
                  role.name = newName;
                  if (window.saveNow) window.saveNow();
                  if (window.c3) window.c3.Toast({ title: '角色昵称已修改为: ' + newName });
                }
              }
            },
            {
              name: '补充体力',
              flag: '资源',
              level: 9997,
              color: cc.v3(16, 185, 129), // 翡翠绿
              helpText: '点击为角色恢复 100 点满额体力',
              func: function () {
                if (role && role.energy) {
                  role.energy.value = Math.max(100, role.energy.valueMax || 100);
                  if (window.saveNow) window.saveNow();
                  if (window.c3) window.c3.Toast({ title: '体力已补满至 ' + role.energy.value });
                }
              }
            },
            {
              name: '增加100钻石',
              flag: '资源',
              level: 9996,
              color: cc.v3(168, 85, 247), // 紫色
              helpText: '点击为账号增加 100 钻石',
              func: function () {
                if (role) {
                  role.diamond = (role.diamond || 0) + 100;
                  if (window.saveNow) window.saveNow();
                  if (window.c3) window.c3.Toast({ title: '已获得 100 钻石！当前钻石: ' + role.diamond });
                }
              }
            },
            {
              name: '重置当前账号',
              flag: '账号',
              level: 9995,
              color: cc.v3(239, 68, 68), // 亮红
              helpText: '清空当前 UID 进度，全新重新开始第一天',
              func: function () {
                if (window.c3 && window.c3.Alert) {
                  window.c3.Alert({
                    title: '重置确认',
                    content: '确定要清空当前账号并重新开始游戏吗？',
                    confirm: function () {
                      if (window.resetGameProgress) window.resetGameProgress();
                    }
                  });
                } else if (confirm('确定要清空当前账号并重新开始游戏吗？')) {
                  if (window.resetGameProgress) window.resetGameProgress();
                }
              }
            }
          ];

          if (this.list) {
            this.list.data = customTools;
          }
        };
        console.log('[GM] ExtraGmTool 5功能极简版已成功挂载！');
      }

      // 3. 终极兜底：Hook GmTool.prototype.onClickShow
      var gmToolCls = cc.js.getClassByName('GmTool');
      if (gmToolCls && gmToolCls.prototype && !gmToolCls.prototype.__filterHooked) {
        gmToolCls.prototype.__filterHooked = true;
        var origOnClickShow = gmToolCls.prototype.onClickShow;
        gmToolCls.prototype.onClickShow = function () {
          try {
            var extraComp = this.extraGm && (this.extraGm.getComponent(extraGmCls) || this.extraGm.getComponent('ExtraGmTool'));
            if (extraComp && typeof extraComp.initGmList === 'function') {
              extraComp.initGmList('');
            }
          } catch (e) {}
          return origOnClickShow.apply(this, arguments);
        };
        console.log('[GM] GmTool.prototype.onClickShow 终极拦截已就绪！');
      }

      return true;
    }

    // 独立持续轮询，确保业务脚本加载完毕后必定挂载
    (function () {
      var gmAttempts = 0;
      var gmTimer = setInterval(function () {
        gmAttempts++;
        if (applyExtraGmToolHook()) {
          clearInterval(gmTimer);
        }
        if (gmAttempts >= 120) {
          clearInterval(gmTimer);
        }
      }, 300);
    })();

    // 2. 深度拦截 GooseWorld 与实体上的 setDebugText / setDebugVisible
    var patchDebugMethods = function () {
      if (window.GooseWorld && window.GooseWorld.prototype) {
        if (window.GooseWorld.prototype.initDebug) {
          window.GooseWorld.prototype.initDebug = function () {};
        }
      }
      if (window.GooseWorld && window.GooseWorld.instance && window.GooseWorld.instance.debugHelper) {
        var dh = window.GooseWorld.instance.debugHelper;
        dh.debugTextEnabled = false;
        dh.adornIdDebugEnabled = false;
        dh.debugModeEnabled = false;
        dh.perFrameDraw = function () {};
      }
    };

    // 尝试立刻 hook，或定时等待 cc 就绪
    if (!hookLabel()) {
      var timer = setInterval(function () {
        if (hookLabel()) clearInterval(timer);
      }, 300);
    }

    // 3. 挂接到场景生命周期与循环巡检
    var scanAndClean = function (root) {
      if (!root) return;
      cleanNode(root);
      if (root.children) {
        for (var i = 0; i < root.children.length; i++) {
          scanAndClean(root.children[i]);
        }
      }
    };

    if (typeof cc !== 'undefined' && cc.director) {
      cc.director.on(cc.Director.EVENT_AFTER_SCENE_LAUNCH, function () {
        var s = cc.director.getScene();
        if (s) {
          scanAndClean(s);
        }
        patchDebugMethods();
      });
    }

    setInterval(function () {
      if (typeof cc !== 'undefined' && cc.director) {
        var s = cc.director.getScene();
        if (s) {
          scanAndClean(s);
        }
        patchDebugMethods();
      }
    }, 1500);
  }

  try {
    installDebugDisplaySanitizer();
  } catch (e) {
    console.warn('[mock-network] installDebugDisplaySanitizer 异常:', e);
  }

  // 存档兜底:10 秒定时 + 页面隐藏/卸载时强制落盘
  setInterval(saveNow, 10000);
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) saveNow();
  });
})(typeof window !== 'undefined' ? window : this);
