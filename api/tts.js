// Edge function — proxies Inworld TTS streaming so the auth header stays server-side.
// Streams the NDJSON response straight back to the browser (no buffering on Vercel).
export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const auth = process.env.INWORLD_AUTH;
  if (!auth) {
    return jsonError(500, 'INWORLD_AUTH env var not configured on the server.');
  }

  let bodyText;
  try {
    bodyText = await request.text();
  } catch (e) {
    return jsonError(400, 'Could not read request body.');
  }

  try {
    const upstream = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
      },
      body: bodyText,
    });

    // Pipe the response stream back to the client without buffering.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
      },
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
