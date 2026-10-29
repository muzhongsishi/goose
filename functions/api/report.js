// Cloudflare Pages Function: /api/report
// 接收并存储来自移动端真机（特别是 iOS Safari / WebKit）的真实报错与高频日志

let memoryLogs = [];

export async function onRequestPost({ request, env }) {
  try {
    const data = await request.json();
    const item = {
      time: new Date().toISOString(),
      ua: request.headers.get('user-agent') || '',
      ip: request.headers.get('cf-connecting-ip') || '',
      data: data
    };

    const kv = env && env.GOOSE_KV;
    if (kv) {
      let raw = await kv.get('client_reports');
      let list = raw ? JSON.parse(raw) : [];
      list.unshift(item);
      if (list.length > 50) list = list.slice(0, 50);
      await kv.put('client_reports', JSON.stringify(list));
    } else {
      memoryLogs.unshift(item);
      if (memoryLogs.length > 50) memoryLogs = memoryLogs.slice(0, 50);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestGet({ request, env }) {
  const kv = env && env.GOOSE_KV;
  let list = [];
  if (kv) {
    let raw = await kv.get('client_reports');
    list = raw ? JSON.parse(raw) : [];
  } else {
    list = memoryLogs;
  }
  return new Response(JSON.stringify({ ok: true, reports: list }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
