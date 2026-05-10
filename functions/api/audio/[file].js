/**
 * /api/audio/<file> — gated, encrypted R2 streaming endpoint.
 *
 * Hotlink protection: only serves when the request originates from
 * null-n.com (or a Pages preview deploy). Direct hits and embeds from
 * other sites get 403 instead of audio bytes.
 *
 * Obfuscation layer: response is AES-GCM encrypted before send.
 * Network-tab capture yields ciphertext, not playable audio. The
 * client decrypts with the same key (in js/main.js) before passing
 * the bytes to AudioContext.decodeAudioData.
 *
 * R2 binding: env.AUDIO_BUCKET → null-n-audio
 */
const STREAM_KEY_B64 = 'k7Vs1GXZCawdoMaYFDtGCH/umDLu/VF1Qm5IKIJPQqY=';

const allowedExact = new Set([
  'https://null-n.com',
  'https://www.null-n.com',
]);
const previewRe = /^https:\/\/(?:[\w-]+\.)?null-n-com\.pages\.dev$/;
const isAllowed = (origin) =>
  allowedExact.has(origin) || previewRe.test(origin);

let cachedKey = null;
async function getEncryptKey() {
  if (cachedKey) return cachedKey;
  const raw = Uint8Array.from(atob(STREAM_KEY_B64), c => c.charCodeAt(0));
  cachedKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  return cachedKey;
}

export async function onRequest({ request, env, params }) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  let okay = origin ? isAllowed(origin) : false;
  if (!okay && referer) {
    try { okay = isAllowed(new URL(referer).origin); } catch (_) {}
  }
  if (!okay) return new Response('Forbidden', { status: 403 });

  const key = decodeURIComponent(params.file);
  const obj = await env.AUDIO_BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const plain = await obj.arrayBuffer();
  const cryptoKey = await getEncryptKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plain);

  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(cipher), 12);

  return new Response(out, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(out.byteLength),
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
