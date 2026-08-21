import { Buffer } from 'node:buffer';

export const info = {
  id: 'multi-tts-fish-bridge',
  name: 'Multi-TTS Fish Bridge',
  description: 'Server-side Fish Audio bridge for Multi-TTS.',
};

export const API_VERSION = '1';
export const FISH_AUDIO_MODEL_URL = 'https://api.fish.audio/model';
export const FISH_AUDIO_SPEECH_URL = 'https://api.fish.audio/v1/tts';
export const ALLOWED_MODELS = new Set(['s2.1-pro-free', 's2.1-pro']);
export const DEFAULT_LATENCY = 'normal';
export const MAX_API_KEY_LENGTH = 512;
export const MAX_REFERENCE_ID_LENGTH = 512;
export const MAX_TEXT_LENGTH = 8000;
export const MAX_BODY_BYTES = 128 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

const AUDIO_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mpeg3',
  'audio/x-mpeg',
  'audio/x-mpeg-3',
]);

class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readHeader(request, name) {
  if (typeof request?.get === 'function') {
    const value = request.get(name);
    if (typeof value === 'string') {
      return value;
    }
  }

  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : '';
  }
  return typeof value === 'string' ? value : '';
}

function sendJson(response, status, payload) {
  if (typeof response?.status === 'function' && typeof response?.json === 'function') {
    response.status(status).json(payload);
    return;
  }
  response.statusCode = status;
  response.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  response.end?.(JSON.stringify(payload));
}

function sendError(response, error) {
  if (response?.headersSent || response?.destroyed) {
    return;
  }
  const bridge_error = error instanceof BridgeError
    ? error
    : new BridgeError(502, 'bridge_internal_error', 'Fish Bridge 内部错误');
  sendJson(response, bridge_error.status, {
    ok: false,
    code: bridge_error.code,
    message: bridge_error.message,
  });
}

function requestBodyTooLarge(request) {
  const raw_length = readHeader(request, 'content-length');
  if (!raw_length) {
    return false;
  }
  const length = Number(raw_length);
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

function requireFishApiKey(request) {
  const api_key = readHeader(request, 'x-fish-api-key').trim();
  if (!api_key || api_key.length > MAX_API_KEY_LENGTH || /[\r\n]/.test(api_key)) {
    throw new BridgeError(400, 'bridge_missing_api_key', '请提供有效的 X-Fish-API-Key。');
  }
  return api_key;
}

function requireFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BridgeError(400, 'bridge_invalid_request', `${field} 必须是有限数字。`);
  }
  return value;
}

function parseSpeechRequest(request) {
  if (requestBodyTooLarge(request)) {
    throw new BridgeError(413, 'bridge_body_too_large', '请求正文过大。');
  }

  const body = request?.body;
  if (!isRecord(body)) {
    throw new BridgeError(400, 'bridge_invalid_request', '请求正文必须是 JSON 对象。');
  }
  try {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      throw new BridgeError(413, 'bridge_body_too_large', '请求正文过大。');
    }
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError(400, 'bridge_invalid_request', '请求正文无法解析。');
  }

  if (typeof body.text !== 'string' || !body.text.trim()) {
    throw new BridgeError(400, 'bridge_invalid_request', 'text 必须是非空字符串。');
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    throw new BridgeError(400, 'bridge_text_too_long', `text 不能超过 ${MAX_TEXT_LENGTH} 个字符。`);
  }

  if (typeof body.reference_id !== 'string' || !body.reference_id.trim()) {
    throw new BridgeError(400, 'bridge_invalid_request', 'reference_id 必须是非空字符串。');
  }
  if (body.reference_id.trim().length > MAX_REFERENCE_ID_LENGTH) {
    throw new BridgeError(400, 'bridge_invalid_request', 'reference_id 长度不合理。');
  }

  if (typeof body.model !== 'string' || !ALLOWED_MODELS.has(body.model)) {
    throw new BridgeError(400, 'bridge_invalid_model', 'model 不是受支持的 Fish Audio 模型。');
  }

  if (body.format !== undefined && body.format !== 'mp3') {
    throw new BridgeError(400, 'bridge_invalid_format', 'format 只支持 mp3。');
  }
  if (body.normalize !== undefined && typeof body.normalize !== 'boolean') {
    throw new BridgeError(400, 'bridge_invalid_request', 'normalize 必须是 boolean。');
  }
  if (body.latency !== undefined && body.latency !== DEFAULT_LATENCY) {
    throw new BridgeError(400, 'bridge_invalid_request', 'latency 只支持 normal。');
  }

  if (!isRecord(body.prosody)) {
    throw new BridgeError(400, 'bridge_invalid_request', 'prosody 必须是 JSON 对象。');
  }
  const speed = requireFiniteNumber(body.prosody.speed ?? 1, 'prosody.speed');
  if (speed < 0.5 || speed > 2) {
    throw new BridgeError(400, 'bridge_invalid_request', 'prosody.speed 必须在 0.5 到 2.0 之间。');
  }
  const volume = requireFiniteNumber(body.prosody.volume ?? 0, 'prosody.volume');
  if (
    body.prosody.normalize_loudness !== undefined &&
    typeof body.prosody.normalize_loudness !== 'boolean'
  ) {
    throw new BridgeError(400, 'bridge_invalid_request', 'prosody.normalize_loudness 必须是 boolean。');
  }

  return {
    text: body.text,
    reference_id: body.reference_id.trim(),
    model: body.model,
    format: 'mp3',
    normalize: body.normalize ?? true,
    latency: body.latency ?? DEFAULT_LATENCY,
    prosody: {
      speed,
      volume,
      normalize_loudness: body.prosody.normalize_loudness ?? true,
    },
  };
}

function upstreamMessage(status, operation) {
  if (status === 401) {
    return { code: 'fish_auth_failed', message: 'Fish Audio API Key 无效或无权访问该资源。' };
  }
  if (status === 402) {
    return { code: 'fish_billing_unavailable', message: 'Fish Audio 账户余额或套餐不可用。' };
  }
  if (status === 404) {
    return {
      code: operation === 'speech' ? 'fish_reference_not_found' : 'fish_resource_not_found',
      message: operation === 'speech' ? 'Fish Audio reference_id 不存在。' : 'Fish Audio 资源不存在。',
    };
  }
  if (status === 422) {
    return { code: 'fish_invalid_request', message: 'Fish Audio 请求参数无效。' };
  }
  if (status === 429) {
    return { code: 'fish_rate_limited', message: 'Fish Audio 请求受到限流。' };
  }
  if (status >= 500) {
    return { code: 'fish_upstream_error', message: 'Fish Audio 服务异常。' };
  }
  return { code: 'fish_request_failed', message: `Fish Audio 请求失败（HTTP ${status}）。` };
}

async function readUpstreamError(response, operation) {
  const mapped = upstreamMessage(response.status, operation);
  try {
    await response.text();
  } catch {
    // The status classification is safer than exposing an untrusted upstream body.
  }
  return new BridgeError(response.status >= 400 ? response.status : 502, mapped.code, mapped.message);
}

function attachListener(target, event, listener) {
  if (typeof target?.on !== 'function') {
    return () => {};
  }
  target.on(event, listener);
  return () => {
    if (typeof target.off === 'function') {
      target.off(event, listener);
    } else if (typeof target.removeListener === 'function') {
      target.removeListener(event, listener);
    }
  };
}

async function fetchFish({ fetchImpl, request, response, url, init, timeoutMs }) {
  const controller = new AbortController();
  let settled = false;
  let timeout_id;
  const abort = (reason) => {
    if (!settled && !controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const remove_request_abort = attachListener(request, 'aborted', () => abort('cancelled'));
  const remove_response_close = attachListener(response, 'close', () => abort('cancelled'));
  timeout_id = setTimeout(() => abort('timeout'), timeoutMs);

  try {
    const upstream = await fetchImpl(url, { ...init, signal: controller.signal });
    return {
      response: upstream,
      release() {
        settled = true;
        clearTimeout(timeout_id);
        remove_request_abort();
        remove_response_close();
      },
    };
  } catch (error) {
    clearTimeout(timeout_id);
    remove_request_abort();
    remove_response_close();
    if (controller.signal.reason === 'timeout') {
      throw new BridgeError(504, 'timeout', 'Fish Audio 请求超时。');
    }
    if (controller.signal.aborted) {
      throw new BridgeError(499, 'cancelled', 'Fish Audio 请求已取消。');
    }
    throw new BridgeError(502, 'bridge_upstream_error', '无法连接 Fish Audio 服务。');
  }
}

async function handleHealth(_request, response) {
  sendJson(response, 200, {
    ok: true,
    service: info.id,
    api_version: API_VERSION,
  });
}

async function handleModels(request, response, options) {
  const api_key = requireFishApiKey(request);
  const upstream = await fetchFish({
    fetchImpl: options.fetchImpl,
    request,
    response,
    url: `${FISH_AUDIO_MODEL_URL}?self=true&page_size=100&page_number=1`,
    init: {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${api_key}`,
        Accept: 'application/json',
      },
    },
    timeoutMs: options.timeoutMs,
  });

  try {
    if (!upstream.response.ok) {
      throw await readUpstreamError(upstream.response, 'models');
    }
    let payload;
    try {
      payload = await upstream.response.json();
    } catch {
      throw new BridgeError(502, 'fish_invalid_response', 'Fish Audio 返回了无法解析的模型列表。');
    }
    if (!isRecord(payload)) {
      throw new BridgeError(502, 'fish_invalid_response', 'Fish Audio 模型列表结构无效。');
    }
    sendJson(response, 200, payload);
  } finally {
    upstream.release();
  }
}

async function handleSpeech(request, response, options) {
  const api_key = requireFishApiKey(request);
  const input = parseSpeechRequest(request);
  const upstream = await fetchFish({
    fetchImpl: options.fetchImpl,
    request,
    response,
    url: FISH_AUDIO_SPEECH_URL,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api_key}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        model: input.model,
      },
      body: JSON.stringify({
        text: input.text,
        reference_id: input.reference_id,
        format: input.format,
        normalize: input.normalize,
        latency: input.latency,
        prosody: input.prosody,
      }),
    },
    timeoutMs: options.timeoutMs,
  });

  try {
    if (!upstream.response.ok) {
      throw await readUpstreamError(upstream.response, 'speech');
    }
    const content_type = upstream.response.headers.get('content-type');
    const media_type = (content_type ?? '').split(';', 1)[0].trim().toLowerCase();
    if (media_type && !AUDIO_CONTENT_TYPES.has(media_type)) {
      throw new BridgeError(502, 'fish_invalid_response', 'Fish Audio 返回的不是 MP3 音频。');
    }
    const bytes = Buffer.from(await upstream.response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new BridgeError(502, 'fish_empty_audio', 'Fish Audio 返回的音频为空。');
    }
    response.statusCode = 200;
    response.setHeader?.('Content-Type', content_type || 'audio/mpeg');
    response.setHeader?.('Content-Length', String(bytes.byteLength));
    response.end?.(bytes);
  } finally {
    upstream.release();
  }
}

export function createBridgeHandlers({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('当前 Node.js 不提供 fetch。');
  }
  const options = { fetchImpl, timeoutMs };
  return {
    health: async (request, response) => {
      try {
        await handleHealth(request, response);
      } catch (error) {
        sendError(response, error);
      }
    },
    models: async (request, response) => {
      try {
        await handleModels(request, response, options);
      } catch (error) {
        sendError(response, error);
      }
    },
    speech: async (request, response) => {
      try {
        await handleSpeech(request, response, options);
      } catch (error) {
        sendError(response, error);
      }
    },
  };
}

export function registerRoutes(router, options = {}) {
  const handlers = createBridgeHandlers(options);
  router.get('/health', handlers.health);
  router.post('/models', handlers.models);
  router.post('/speech', handlers.speech);
  return handlers;
}

export async function init(router) {
  registerRoutes(router);
}

export async function exit() {
  // The bridge keeps no process-wide state and has no cleanup work.
}
