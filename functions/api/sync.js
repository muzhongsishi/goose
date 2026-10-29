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

  try {
    if (kv) {
      roleData = await kv.get(`role_${uid}`);
      const rawUserMails = await kv.get(`mails_${uid}`);
      const rawGlobalMails = await kv.get(`mails_global`);
      const userMails = rawUserMails ? JSON.parse(rawUserMails) : [];
      const globalMails = rawGlobalMails ? JSON.parse(rawGlobalMails) : [];
      newMails = [...userMails, ...globalMails];
    } else {
      roleData = memoryStore.roles[uid] || null;
      const userMails = memoryStore.userMails[uid] || [];
      newMails = [...userMails, ...memoryStore.globalMails];
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
      }
    ];

    systemSpecialMails.forEach(sm => {
      if (sm.targetUid === uid || sm.targetUid === 'all') {
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

  try {
    if (kv) {
      try {
        // 1. 保存角色完整存档
        await kv.put(`role_${uid}`, typeof roleData === 'string' ? roleData : JSON.stringify(roleData));
        
        // 2. 更新玩家元信息索引
        const userMeta = {
          uid,
          updatedAt: now,
          day: dayVal,
          level: summary.level || 1,
          coin: summary.coin || 0,
          diamond: summary.diamond || 0,
          energy: summary.energy || 0
        };
        await kv.put(`user_${uid}`, JSON.stringify(userMeta));

        // 3. 加入全局用户列表索引
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
        memoryStore.users[uid] = { uid, updatedAt: now, day: dayVal, ...summary };
      }
    } else {
      memoryStore.roles[uid] = typeof roleData === 'string' ? roleData : JSON.stringify(roleData);
      memoryStore.users[uid] = {
        uid,
        updatedAt: now,
        ...summary
      };
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
