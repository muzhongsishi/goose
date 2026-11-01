// Cloudflare Pages Function: /api/admin
// 获取玩家概览列表

const ADMIN_SECRET = 'admin666';

// 常用默认展示账号
const DEFAULT_UIDS = ['杰杰', '杰杰测试版', '1001', '1002', '1003', 'jiejie_test'];

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
  const secret = url.searchParams.get('secret');
  if (secret !== ADMIN_SECRET) {
    return jsonResp({ ok: false, error: 'Unauthorized secret' }, 403);
  }

  const kv = context.env && context.env.GAME_KV;
  const users = [];
  const indexList = [...DEFAULT_UIDS];

  if (kv) {
    let rawIndex = await kv.get('users_index');
    if (rawIndex) {
      try {
        const storedList = JSON.parse(rawIndex);
        if (Array.isArray(storedList)) {
          for (const uid of storedList) {
            if (!indexList.includes(uid)) indexList.push(uid);
          }
        }
      } catch (e) {}
    }

    for (const uid of indexList) {
      let userData = null;
      if (globalThis.__memoryUsers && globalThis.__memoryUsers[uid]) {
        userData = { ...globalThis.__memoryUsers[uid] };
      }
      if (!userData && kv) {
        try {
          const rawUser = await kv.get(`user_${uid}`);
          if (rawUser) userData = JSON.parse(rawUser);
        } catch (e) {}
      }
      if (userData) {
        if ((uid === '杰杰' || uid === '杰杰测试版') && (!userData.day || userData.day < 15)) {
          userData.day = 15;
        }
        users.push(userData);
      } else {
        users.push({
          uid,
          updatedAt: Date.now(),
          day: (uid === '杰杰' || uid === '杰杰测试版') ? 15 : 1,
          level: 1,
          coin: 0,
          diamond: 0,
          energy: 100
        });
      }
    }
  }

  return jsonResp({
    ok: true,
    users,
    total: users.length,
    time: Date.now()
  });
}
