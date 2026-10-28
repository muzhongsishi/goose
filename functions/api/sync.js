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

  try {
    if (kv) {
      // 1. 保存角色完整存档
      await kv.put(`role_${uid}`, typeof roleData === 'string' ? roleData : JSON.stringify(roleData));
      
      // 2. 更新玩家元信息索引
      const userMeta = {
        uid,
        updatedAt: now,
        day: summary.day || 1,
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
