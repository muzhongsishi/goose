// Cloudflare Pages Function: /api/admin
// 获取玩家概览列表

const ADMIN_SECRET = 'admin666';

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
  const secret = url.searchParams.get('secret');
  if (secret !== ADMIN_SECRET) {
    return jsonResp({ ok: false, error: 'Unauthorized secret' }, 403);
  }

  const kv = context.env && context.env.GAME_KV;
  const users = [];

  if (kv) {
    const rawIndex = await kv.get('users_index');
    const indexList = rawIndex ? JSON.parse(rawIndex) : [];
    for (const uid of indexList) {
      const rawUser = await kv.get(`user_${uid}`);
      if (rawUser) {
        users.push(JSON.parse(rawUser));
      } else {
        users.push({ uid, updatedAt: 0 });
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
