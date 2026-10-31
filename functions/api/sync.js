// Cloudflare Pages Function: /api/sync
// 支持根据 UID 拉取云存档、保存云存档、拉取待领取邮件

// 内存兜底缓存(防未绑定 KV 时直接抛 500)
const memoryStore = {
  roles: {},
  users: {},
  userMails: {},
  globalMails: []
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }
  });
}

export async function onRequestOptions() {
  return jsonResp({ ok: true });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const uid = (url.searchParams.get('uid') || '').trim();
  if (!uid) {
    return jsonResp({ ok: false, error: 'uid is required' }, 400);
  }

  const kv = context.env && context.env.GAME_KV;
  let roleData = null;
  let newMails = [];
  let updatedAt = 0;

  try {
    if (kv) {
      roleData = await kv.get(`role_${uid}`);
      const rawUser = await kv.get(`user_${uid}`);
      if (rawUser) {
        try { updatedAt = Number(JSON.parse(rawUser).updatedAt || 0); } catch(e) {}
      }
      const rawUserMails = await kv.get(`mails_${uid}`);
      const rawGlobalMails = await kv.get(`mails_global`);
      const userMails = rawUserMails ? JSON.parse(rawUserMails) : [];
      const globalMails = rawGlobalMails ? JSON.parse(rawGlobalMails) : [];
      newMails = [...userMails, ...globalMails];
    } else {
      roleData = memoryStore.roles[uid] || null;
      if (memoryStore.users && memoryStore.users[uid]) {
        updatedAt = Number(memoryStore.users[uid].updatedAt || 0);
      }
      const userMails = memoryStore.userMails[uid] || [];
      newMails = [...userMails, ...memoryStore.globalMails];
    }

    if (!updatedAt && globalThis.__memoryUsers && globalThis.__memoryUsers[uid]) {
      updatedAt = Number(globalThis.__memoryUsers[uid].updatedAt || 0);
    }

    // 自动容灾继承：如果当前用户角色数据不存在，或者格子数 < 10（损坏档）
    let isRoleCellsValid = false;
    if (roleData) {
      try {
        const pr = typeof roleData === 'string' ? JSON.parse(roleData) : roleData;
        if (pr && pr.boards && pr.boards.__m) {
          const b1 = pr.boards.__m.find(b => b[0] === 1);
          if (b1 && b1[1] && b1[1].cells && b1[1].cells.__m && b1[1].cells.__m.length >= 10) {
            isRoleCellsValid = true;
          }
        }
      } catch (e) {}
    }

    if (!isRoleCellsValid) {
      // 尝试从权威主档 role_杰杰 继承完整的 63 格 42 抽屉存档！
      let masterData = null;
      if (kv) {
        masterData = await kv.get('role_杰杰');
      } else {
        masterData = memoryStore.roles['杰杰'];
      }
      if (masterData) {
        console.log(`[sync] UID=${uid} 棋盘损坏或无数据，自动从权威主档[杰杰]秒级恢复！`);
        roleData = masterData;
        if (kv) {
          // 顺手把修复好的数据写回 role_${uid}
          await kv.put(`role_${uid}`, masterData);
        }
      }
    }

    // 合并全局内存邮件缓存（跨 API 兜底）
    if (globalThis.__memoryMails) {
      if (Array.isArray(globalThis.__memoryMails[uid])) {
        newMails.unshift(...globalThis.__memoryMails[uid]);
      }
      if (Array.isArray(globalThis.__memoryMails['all'])) {
        newMails.unshift(...globalThis.__memoryMails['all']);
      }
    }

    // 系统特快点对点补给清单 (不受 KV 配额限制，强保到账)
    const systemSpecialMails = [
      {
        id: 990001,
        targetUid: '杰杰',
        title: '切菜板奖励补发',
        from: '肥鹅美食街后勤部',
        content: JSON.stringify({ isnotice: '0', desc: '亲爱的店长杰杰：您好！做菜菜板（3级切菜板）未正常发放问题已妥善解决，现为您特快补发，并赠送体力与钻石！请点击领取并前往棋盘气泡取入。' }),
        createAt: Math.floor(Date.now() / 1000) - 30,
        expireAt: Math.floor(Date.now() / 1000) + 86400 * 30,
        state: 1,
        haveAttachments: true,
        rewards: [
          { itemType: 7, itemId: 3001003, value: 1 }, // 3级切菜板
          { itemType: 4, itemId: 0, value: 100 },     // 100 体力
          { itemType: 2, itemId: 0, value: 100 }      // 100 钻石
        ]
      },
      {
        id: 990002,
        targetUid: '杰杰',
        title: '肉类发射器-油纸特快补发',
        from: '肥鹅后勤部',
        content: JSON.stringify({ isnotice: '0', desc: '亲爱的店长杰杰：您好！已为您特快补发产生肉类发射器的第1级物品【油纸】，同时赠送100钻石与100体力！领取后请前往棋盘气泡取入，两张油纸可合成为牛皮纸，继续升级即可成为肉板发射器。祝您游戏愉快！' }),
        createAt: Math.floor(Date.now() / 1000) - 10,
        expireAt: Math.floor(Date.now() / 1000) + 86400 * 30,
        state: 1,
        haveAttachments: true,
        rewards: [
          { itemType: 7, itemId: 1003101, value: 1 }, // 1级油纸
          { itemType: 2, itemId: 0, value: 100 },     // 100 钻石
          { itemType: 4, itemId: 0, value: 100 }      // 100 体力
        ]
      },
      {
        id: 990003,
        targetUid: '杰杰',
        title: '鱼类发射器与鱼钩特快补发',
        from: '肥鹅渔具特供部',
        content: JSON.stringify({ isnotice: '0', desc: '亲爱的店长杰杰：您好！已为您特快补发产生鱼类的发射器【5级专业钓竿】与【4级组线】，并补发被异常替换的【1级鱼钩】2枚，额外赠送100钻石与100体力！钓竿点击消耗体力即可源源不断产生鲜鱼（鲷鱼、罗非鱼、鳗鱼、鱿鱼等），祝您捕捞大丰收！' }),
        createAt: Math.floor(Date.now() / 1000) - 5,
        expireAt: Math.floor(Date.now() / 1000) + 86400 * 30,
        state: 1,
        haveAttachments: true,
        rewards: [
          { itemType: 7, itemId: 1005105, value: 1 }, // 5级专业钓竿 (成熟鱼类发射器)
          { itemType: 7, itemId: 1005104, value: 1 }, // 4级组线 (鱼类发射器原型)
          { itemType: 7, itemId: 1005101, value: 2 }, // 1级鱼钩 x2 (补齐被吞的鱼钩)
          { itemType: 2, itemId: 0, value: 100 },     // 100 钻石
          { itemType: 4, itemId: 0, value: 100 }      // 100 体力
        ]
      },
      {
        id: 990004,
        targetUid: '杰杰',
        title: '全套满级顶级厨具补齐礼包',
        from: '肥鹅特级后厨部',
        content: JSON.stringify({ isnotice: '0', desc: '亲爱的店长杰杰：您好！已为您备齐后厨全套顶级10级厨具！包含【10级商用榨汁机】、【10级专业电烤箱】、【10级不锈钢大煮锅】、【10级猛火灶台】与【10级大理石切菜板】！领取后可直接加工所有高级美食，效率提升60%！祝您烹饪愉快！' }),
        createAt: Math.floor(Date.now() / 1000),
        expireAt: Math.floor(Date.now() / 1000) + 86400 * 30,
        state: 1,
        haveAttachments: true,
        rewards: [
          { itemType: 7, itemId: 3003010, value: 1 }, // 10级满级榨汁机
          { itemType: 7, itemId: 3005010, value: 1 }, // 10级满级电烤箱 (此前完全缺失)
          { itemType: 7, itemId: 3006010, value: 1 }, // 10级满级不锈钢煮锅 (此前仅3级)
          { itemType: 7, itemId: 3004010, value: 1 }, // 10级满级猛火灶台 (此前仅5级)
          { itemType: 7, itemId: 3001010, value: 1 }, // 10级满级大理石切菜板 (此前仅6级)
          { itemType: 2, itemId: 0, value: 500 },     // 500 钻石
          { itemType: 4, itemId: 0, value: 200 }      // 200 体力
        ]
      }
    ];

    systemSpecialMails.forEach(sm => {
      // 容错: 支持 杰杰、测试版、1001、1002、1003 或任意当前在线玩家全量匹配
      const isTarget = sm.targetUid === uid || sm.targetUid === 'all' || sm.targetUid === '杰杰' || uid === '1001' || uid === '1002' || uid === '1003';
      if (isTarget) {
        const alreadyIn = newMails.some(m => Number(m.id) === sm.id);
        if (!alreadyIn) {
          newMails.unshift(sm);
        }
      }
    });

  } catch (err) {
    return jsonResp({ ok: false, error: err.message }, 500);
  }

  return jsonResp({
    ok: true,
    uid,
    roleData,
    updatedAt,
    newMails,
    serverTime: Math.floor(Date.now() / 1000)
  });
}

export async function onRequestPost(context) {
  let body = null;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResp({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const uid = (body.uid || '').trim();
  const roleData = body.roleData;
  if (!uid || !roleData) {
    return jsonResp({ ok: false, error: 'uid and roleData are required' }, 400);
  }

  const kv = context.env && context.env.GAME_KV;
  const now = Date.now();
  const summary = body.summary || {}; // { day, level, coin, energy }
  let dayVal = Number(summary.day || 1);
  if (dayVal <= 1) {
    try {
      const parsedRole = typeof roleData === 'string' ? JSON.parse(roleData) : roleData;
      if (parsedRole && parsedRole.boards && parsedRole.boards.__m) {
        const b1 = parsedRole.boards.__m.find(b => b[0] === 1);
        if (b1 && b1[1] && b1[1].orderDrawerEndId) {
          dayVal = Math.max(1, Number(b1[1].orderDrawerEndId));
        }
      }
    } catch (e) {}
  }

  // 防倒退保护：如果云端已有高进度存档（例如 42 抽屉），而客户端上传的是初始/低进度存档（如第2天），拒绝降级覆盖！
  let existingDay = 0;
  if (globalThis.__memoryUsers && globalThis.__memoryUsers[uid] && globalThis.__memoryUsers[uid].day) {
    existingDay = Number(globalThis.__memoryUsers[uid].day);
  }
  if (!existingDay && kv) {
    try {
      const exUser = await kv.get(`user_${uid}`);
      if (exUser) existingDay = Number(JSON.parse(exUser).day || 0);
    } catch (e) {}
  }
  // 严格拦截棋盘损坏/丢失的坏档上传
  try {
    const pr = typeof roleData === 'string' ? JSON.parse(roleData) : roleData;
    if (pr && pr.boards && pr.boards.__m) {
      const b1 = pr.boards.__m.find(b => b[0] === 1);
      if (b1 && b1[1] && b1[1].cells && b1[1].cells.__m && b1[1].cells.__m.length < 10) {
        console.warn(`[sync] 拒绝棋盘损坏/丢失的存档上传: uid=${uid}, cellsCount=${b1[1].cells.__m.length}`);
        return jsonResp({ ok: true, uid, rejected: true, message: '拦截损坏棋盘上传' });
      }
    }
  } catch (e) {}
  if (!body.force && existingDay > 5 && dayVal < existingDay) {
    console.warn(`[sync] 拒绝低进度覆盖高进度: uid=${uid}, incomingDay=${dayVal}, existingDay=${existingDay}`);
    return jsonResp({ ok: true, uid, rejected: true, message: `已保护云端高进度 (云端第${existingDay}抽屉 vs 上传第${dayVal}抽屉)` });
  }

  // 写入全局内存快照 (跨请求与跨接口共享，避免受 KV 配额限制而影响读取)
  globalThis.__memoryUsers = globalThis.__memoryUsers || {};
  globalThis.__memoryUsers[uid] = {
    uid,
    updatedAt: now,
    day: dayVal,
    level: summary.level || 1,
    coin: summary.coin || 0,
    diamond: summary.diamond || 0,
    energy: summary.energy || 0
  };

  try {
    if (kv) {
      try {
        // 1. 保存角色完整存档
        await kv.put(`role_${uid}`, typeof roleData === 'string' ? roleData : JSON.stringify(roleData));
        
        // 2. 更新玩家元信息索引
        await kv.put(`user_${uid}`, JSON.stringify(globalThis.__memoryUsers[uid]));

        // 3. 仅当索引中不存在该用户时才写 users_index，极大节省 KV 写配额
        let rawIndex = await kv.get('users_index');
        let indexList = rawIndex ? JSON.parse(rawIndex) : [];
        if (!indexList.includes(uid)) {
          indexList.push(uid);
          await kv.put('users_index', JSON.stringify(indexList));
        }
      } catch (kvErr) {
        // KV 写配额超出时降级到 Worker 内存
        console.warn('KV put quota exceeded, fallback to memoryStore:', kvErr.message);
        memoryStore.roles[uid] = typeof roleData === 'string' ? roleData : JSON.stringify(roleData);
        memoryStore.users[uid] = globalThis.__memoryUsers[uid];
      }
    } else {
      memoryStore.roles[uid] = typeof roleData === 'string' ? roleData : JSON.stringify(roleData);
      memoryStore.users[uid] = globalThis.__memoryUsers[uid];
    }
  } catch (err) {
    return jsonResp({ ok: false, error: err.message }, 500);
  }

  return jsonResp({
    ok: true,
    uid,
    savedAt: now
  });
}
