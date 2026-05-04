// Edge function — proxies DeepSeek chat-completions so the API key stays server-side.
export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'DEEPSEEK_API_KEY env var not configured on the server.');
  }

  let bodyText;
  try {
    bodyText = await request.text();
  } catch (e) {
    return jsonError(400, 'Could not read request body.');
  }

  try {
    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: bodyText,
    });

    const respText = await upstream.text();
    return new Response(respText, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
      },
    });
  } catch (e) {
    return jsonError(502, 'DeepSeek upstream failed: ' + (e && e.message ? e.message : String(e)));
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
