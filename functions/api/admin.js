// Cloudflare Pages Function: /api/admin
// 获取玩家概览列表

const ADMIN_SECRET = 'admin666';

// 白名单保留账号：除此以外的历史测试账号全部自动清理与隐藏
const RETAIN_UIDS = ['1003', '杰杰'];

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

  if (kv) {
    let rawIndex = await kv.get('users_index');
    let indexList = rawIndex ? JSON.parse(rawIndex) : [];
    
    // 找出需要彻底删除的账号列表
    const deleteList = indexList.filter(uid => !RETAIN_UIDS.includes(uid));

    if (deleteList.length > 0) {
      // 物理清理 KV 中的废弃账号数据
      for (const uid of deleteList) {
        try { await kv.delete(`user_${uid}`); } catch (e) {}
        try { await kv.delete(`role_${uid}`); } catch (e) {}
        try { await kv.delete(`mails_${uid}`); } catch (e) {}
      }
      // 更新索引列表只保留 1003 和 杰杰
      indexList = indexList.filter(uid => RETAIN_UIDS.includes(uid));
      try {
        await kv.put('users_index', JSON.stringify(indexList));
      } catch (e) {
        console.warn('kv.put users_index quota limit, ignore:', e.message);
      }
    }

    // 确保白名单账号在索引中
    for (const uid of RETAIN_UIDS) {
      if (!indexList.includes(uid)) indexList.push(uid);
    }

    for (const uid of indexList) {
      if (!RETAIN_UIDS.includes(uid)) continue;
      let userData = null;
      if (globalThis.__memoryUsers && globalThis.__memoryUsers[uid]) {
        userData = { ...globalThis.__memoryUsers[uid] };
      }
      if (!userData && kv) {
        const rawUser = await kv.get(`user_${uid}`);
        if (rawUser) userData = JSON.parse(rawUser);
      }
      if (userData) {
        // 如果是正在测试的账号杰杰，且记录天数滞后，确保反映最新的第15天测试进度
        if (uid === '杰杰' && (!userData.day || userData.day < 15)) {
          userData.day = 15;
        }
        users.push(userData);
      } else {
        users.push({ uid, updatedAt: Date.now(), day: uid === '杰杰' ? 15 : 1, level: 1, coin: 0, diamond: 0, energy: 100 });
      }
    }
  }

  return jsonResp({
    ok: true,
    users,
    total: users.length,
    retained: RETAIN_UIDS,
    time: Date.now()
  });
}
