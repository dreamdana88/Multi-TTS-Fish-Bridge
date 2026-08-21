import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION,
  FISH_AUDIO_MODEL_URL,
  FISH_AUDIO_SPEECH_URL,
  createBridgeHandlers,
  info,
  registerRoutes,
} from '../index.js';

function createRequest({ body, headers = {} } = {}) {
  const listeners = new Map();
  return {
    body,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    get(name) {
      return this.headers[name.toLowerCase()];
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

function createResponse() {
  const listeners = new Map();
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    destroyed: false,
    status(status) {
      this.statusCode = status;
      return this;
    },
    json(payload) {
      this.headers['content-type'] = 'application/json; charset=utf-8';
      this.body = payload;
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
      this.headersSent = true;
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function audioResponse(bytes = Uint8Array.from([0xff, 0xfb, 0x90, 0x64])) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

function speechBody(overrides = {}) {
  return {
    text: '[happy]你好，世界。',
    reference_id: 'ref-123',
    model: 's2.1-pro-free',
    format: 'mp3',
    normalize: true,
    latency: 'normal',
    prosody: {
      speed: 1.1,
      volume: 0.2,
      normalize_loudness: true,
    },
    ...overrides,
  };
}

function assertErrorResponse(response, status, code) {
  assert.equal(response.statusCode, status);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, code);
}

test('exports the SillyTavern plugin contract and registers fixed routes', async () => {
  assert.equal(info.id, 'multi-tts-fish-bridge');
  const calls = [];
  const router = {
    get(path, handler) { calls.push(['GET', path, handler]); },
    post(path, handler) { calls.push(['POST', path, handler]); },
  };
  const handlers = registerRoutes(router, { fetchImpl: async () => jsonResponse({}) });
  assert.deepEqual(calls.map(([method, path]) => [method, path]), [
    ['GET', '/health'],
    ['POST', '/models'],
    ['POST', '/speech'],
  ]);
  assert.equal(typeof handlers.health, 'function');
  assert.equal(typeof handlers.models, 'function');
  assert.equal(typeof handlers.speech, 'function');
});

test('health is local, reports protocol version, and never calls Fish Audio', async () => {
  let fetchCalls = 0;
  const handlers = createBridgeHandlers({ fetchImpl: async () => { fetchCalls += 1; } });
  const response = createResponse();

  await handlers.health(createRequest(), response);

  assert.equal(fetchCalls, 0);
  assert.deepEqual(response.body, {
    ok: true,
    service: info.id,
    api_version: API_VERSION,
  });
});

test('models uses the fixed Fish model URL and server-side Bearer key', async () => {
  const apiKey = 'fish-secret-key';
  let request;
  const handlers = createBridgeHandlers({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({ items: [{ _id: 'voice-1', type: 'tts' }] });
    },
  });
  const response = createResponse();

  await handlers.models(createRequest({ headers: { 'X-Fish-API-Key': apiKey } }), response);

  assert.equal(request.url, `${FISH_AUDIO_MODEL_URL}?self=true&page_size=100&page_number=1`);
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.equal(request.url.includes(apiKey), false);
  assert.deepEqual(response.body.items, [{ _id: 'voice-1', type: 'tts' }]);
});

test('models rejects a missing key without contacting Fish Audio or exposing it', async () => {
  let fetchCalls = 0;
  const handlers = createBridgeHandlers({ fetchImpl: async () => { fetchCalls += 1; } });
  const response = createResponse();

  await handlers.models(createRequest(), response);

  assert.equal(fetchCalls, 0);
  assertErrorResponse(response, 400, 'bridge_missing_api_key');
  assert.equal(JSON.stringify(response.body).includes('Authorization'), false);
});

test('speech sends the frozen Fish contract and returns MP3 bytes unchanged', async () => {
  const apiKey = 'fish-secret-key';
  let request;
  const sourceBytes = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00]);
  const handlers = createBridgeHandlers({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return audioResponse(sourceBytes);
    },
  });
  const response = createResponse();

  await handlers.speech(createRequest({
    headers: { 'X-Fish-API-Key': apiKey },
    body: speechBody({ input: 'must not be forwarded', voice: 'must not be forwarded', response_format: 'wav' }),
  }), response);

  assert.equal(request.url, FISH_AUDIO_SPEECH_URL);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(request.init.headers.Accept, 'audio/mpeg');
  assert.equal(request.init.headers.model, 's2.1-pro-free');
  assert.equal(request.init.headers.model.includes(apiKey), false);
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, {
    text: '[happy]你好，世界。',
    reference_id: 'ref-123',
    format: 'mp3',
    normalize: true,
    latency: 'normal',
    prosody: { speed: 1.1, volume: 0.2, normalize_loudness: true },
  });
  assert.equal('input' in body, false);
  assert.equal('voice' in body, false);
  assert.equal('response_format' in body, false);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'audio/mpeg');
  assert.deepEqual([...response.body], [...sourceBytes]);
});

test('speech validates model, text, format, booleans, and numeric ranges before upstream access', async () => {
  let fetchCalls = 0;
  const handlers = createBridgeHandlers({ fetchImpl: async () => { fetchCalls += 1; } });
  const cases = [
    [{ model: 'public-model' }, 'bridge_invalid_model'],
    [{ text: '   ' }, 'bridge_invalid_request'],
    [{ format: 'wav' }, 'bridge_invalid_format'],
    [{ normalize: 'true' }, 'bridge_invalid_request'],
    [{ latency: 'balanced' }, 'bridge_invalid_request'],
    [{ prosody: { speed: 2.1, volume: 0 } }, 'bridge_invalid_request'],
    [{ prosody: { speed: 1, volume: Number.NaN } }, 'bridge_invalid_request'],
  ];

  for (const [overrides, code] of cases) {
    const response = createResponse();
    await handlers.speech(createRequest({
      headers: { 'X-Fish-API-Key': 'fish-secret-key' },
      body: speechBody(overrides),
    }), response);
    assertErrorResponse(response, 400, code);
  }

  const tooLong = createResponse();
  await handlers.speech(createRequest({
    headers: { 'X-Fish-API-Key': 'fish-secret-key' },
    body: speechBody({ text: 'x'.repeat(8001) }),
  }), tooLong);
  assertErrorResponse(tooLong, 400, 'bridge_text_too_long');
  assert.equal(fetchCalls, 0);
});

test('Fish status classifications are preserved without returning upstream bodies or keys', async () => {
  for (const status of [401, 402, 404, 422, 429, 503]) {
    const apiKey = 'fish-secret-key';
    const handlers = createBridgeHandlers({
      fetchImpl: async (url) => new Response(`upstream body ${apiKey} ${url}`, { status }),
    });
    const response = createResponse();

    await handlers.speech(createRequest({
      headers: { 'X-Fish-API-Key': apiKey },
      body: speechBody(),
    }), response);

    assert.equal(response.statusCode, status);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.message.includes(apiKey), false);
    assert.equal(JSON.stringify(response.body).includes('upstream body'), false);
  }
});

test('timeout and client cancellation abort upstream requests with classified errors', async () => {
  let timeoutSignal;
  const timeoutHandlers = createBridgeHandlers({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      timeoutSignal = init.signal;
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(resolve, 100);
      });
    },
  });
  const timeoutResponse = createResponse();
  await timeoutHandlers.speech(createRequest({
    headers: { 'X-Fish-API-Key': 'fish-secret-key' },
    body: speechBody(),
  }), timeoutResponse);
  assert.equal(timeoutSignal.aborted, true);
  assertErrorResponse(timeoutResponse, 504, 'timeout');

  let cancelSignal;
  let request;
  const cancelHandlers = createBridgeHandlers({
    timeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      cancelSignal = init.signal;
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(resolve, 1000);
      });
    },
  });
  request = createRequest({
    headers: { 'X-Fish-API-Key': 'fish-secret-key' },
    body: speechBody(),
  });
  const cancelResponse = createResponse();
  const pending = cancelHandlers.speech(request, cancelResponse);
  setTimeout(() => request.emit('aborted'), 5);
  await pending;
  assert.equal(cancelSignal.aborted, true);
  assertErrorResponse(cancelResponse, 499, 'cancelled');
});

test('request body limit is enforced before an upstream request', async () => {
  let fetchCalls = 0;
  const handlers = createBridgeHandlers({ fetchImpl: async () => { fetchCalls += 1; } });
  const response = createResponse();

  await handlers.speech(createRequest({
    headers: {
      'X-Fish-API-Key': 'fish-secret-key',
      'Content-Length': String(128 * 1024 + 1),
    },
    body: speechBody(),
  }), response);

  assertErrorResponse(response, 413, 'bridge_body_too_large');
  assert.equal(fetchCalls, 0);
});
