// Cloudflare Pages Function: /api/mail
// 管理员发送邮件(单发/全员)、客户端确认接收邮件

const ADMIN_SECRET = 'admin666'; // 默认管理密钥

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
  const uid = url.searchParams.get('uid') || 'all';
  const kv = context.env && context.env.GAME_KV;
  let list = [];
  try {
    if (kv) {
      const key = uid === 'all' ? 'mails_global' : `mails_${uid}`;
      const raw = await kv.get(key);
      list = raw ? JSON.parse(raw) : [];
    }
  } catch (e) {
    return jsonResp({ ok: false, error: e.message }, 500);
  }
  return jsonResp({ ok: true, uid, mails: list });
}

export async function onRequestPost(context) {
  try {
    let body = null;
    try {
      body = await context.request.json();
    } catch (e) {
      return jsonResp({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const action = body.action || 'send'; // 'send' | 'ack'

    const kv = context.env && context.env.GAME_KV;

    // 1. 发送邮件动作
    if (action === 'send') {
      const secret = body.secret;
      if (secret !== ADMIN_SECRET) {
        return jsonResp({ ok: false, error: 'Unauthorized secret' }, 403);
      }

      const targetUid = (body.targetUid || 'all').trim();
      const mailId = Date.now();
      const mailItem = {
        id: mailId,
        title: body.title || '系统福利补给',
        from: body.from || '肥鹅后勤部',
        content: JSON.stringify({ isnotice: '0', desc: body.content || '店长辛苦了！特意为您准备了补给物资，请查收！' }),
        createAt: Math.floor(Date.now() / 1000),
        expireAt: Math.floor(Date.now() / 1000) + 86400 * 30,
        state: 1, // 1 = 未读未领
        haveAttachments: Boolean(body.rewards && body.rewards.length),
        rewards: body.rewards || [] // [{ itemType: 7, itemId: 3001003, value: 1 }]
      };

      if (kv) {
        if (targetUid === 'all') {
          let raw = await kv.get('mails_global');
          let list = raw ? JSON.parse(raw) : [];
          list.unshift(mailItem);
          await kv.put('mails_global', JSON.stringify(list));
        } else {
          let raw = await kv.get(`mails_${targetUid}`);
          let list = raw ? JSON.parse(raw) : [];
          list.unshift(mailItem);
          await kv.put(`mails_${targetUid}`, JSON.stringify(list));
        }
      }

      return jsonResp({
        ok: true,
        message: `邮件已发送给 [${targetUid}]`,
        mail: mailItem
      });
    }

    // 2. 客户端确认领取/已读邮件(从待下发队列移除)
    if (action === 'ack') {
      const uid = (body.uid || '').trim();
      const mailId = Number(body.mailId);
      if (!uid || !mailId) {
        return jsonResp({ ok: false, error: 'uid and mailId are required' }, 400);
      }

      if (kv) {
        let raw = await kv.get(`mails_${uid}`);
        if (raw) {
          let list = JSON.parse(raw).filter(m => Number(m.id) !== mailId);
          await kv.put(`mails_${uid}`, JSON.stringify(list));
        }
      }

      return jsonResp({ ok: true, acknowledged: mailId });
    }

    return jsonResp({ ok: false, error: 'Unknown action' }, 400);
  } catch (globalErr) {
    return jsonResp({
      ok: false,
      error: globalErr.message || String(globalErr),
      stack: globalErr.stack || ''
    }, 500);
  }
}
