// Edge function — proxies Inworld voice catalog list. GET only.
export const config = { runtime: 'edge' };

export default async function handler(request) {
  const auth = process.env.INWORLD_AUTH;
  if (!auth) {
    return jsonError(500, 'INWORLD_AUTH env var not configured on the server.');
  }

  try {
    const upstream = await fetch('https://api.inworld.ai/tts/v1/voices', {
      headers: { 'Authorization': auth, 'Accept': 'application/json' },
    });
    const respText = await upstream.text();
    return new Response(respText, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return jsonError(502, 'Inworld upstream failed: ' + (e && e.message ? e.message : String(e)));
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
