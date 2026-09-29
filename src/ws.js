const MAX_HEADER_BYTES = 1024;
const MAX_EARLY_BYTES = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeEarlyData(header) {
  if (!header || !/^[A-Za-z0-9_-]+={0,2}$/.test(header)) return null;
  if (header.length > Math.ceil(MAX_EARLY_BYTES * 4 / 3) + 2) return null;
  try {
    const binary = atob(header.replace(/-/g, '+').replace(/_/g, '/'));
    return binary.length <= MAX_EARLY_BYTES
      ? Uint8Array.from(binary, char => char.charCodeAt(0)) : null;
  } catch {
    return null;
  }
}

export function parseVlessHeader(bytes, uuid) {
  if (bytes.length < 18) return { state: 'incomplete' };
  const expected = uuid.replace(/-/g, '').toLowerCase();
  const actual = Array.from(bytes.subarray(1, 17), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) return { state: 'invalid' };

  let offset = 18 + bytes[17];
  if (bytes.length < offset + 4) return { state: 'incomplete' };
  if (bytes[offset++] !== 1) return { state: 'invalid' }; // TCP only
  const port = (bytes[offset++] << 8) | bytes[offset++];
  if (!port) return { state: 'invalid' };
  const addressType = bytes[offset++];
  let hostname;
  if (addressType === 1) {
    if (bytes.length < offset + 4) return { state: 'incomplete' };
    hostname = Array.from(bytes.subarray(offset, offset + 4)).join('.');
    offset += 4;
  } else if (addressType === 2) {
    if (bytes.length < offset + 1) return { state: 'incomplete' };
    const length = bytes[offset++];
    if (!length || bytes.length < offset + length) return { state: length ? 'incomplete' : 'invalid' };
    try { hostname = decoder.decode(bytes.subarray(offset, offset + length)); }
    catch { return { state: 'invalid' }; }
    if (!/^[A-Za-z0-9.-]+$/.test(hostname)) return { state: 'invalid' };
    offset += length;
  } else if (addressType === 3) {
    if (bytes.length < offset + 16) return { state: 'incomplete' };
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(((bytes[offset + i] << 8) | bytes[offset + i + 1]).toString(16));
    hostname = parts.join(':');
    offset += 16;
  } else {
    return { state: 'invalid' };
  }
  return { state: 'ok', version: bytes[0], hostname, port, payload: bytes.subarray(offset) };
}

function joinBytes(a, b) {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

async function messageBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value?.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  return null;
}

export async function handleVlessWebSocket(request, uuid) {
  const { connect } = await import('cloudflare:sockets');
  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = 'arraybuffer';
  server.accept();

  let header = new Uint8Array(0);
  let socket;
  let writer;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket?.close(); } catch {}
    try { if (server.readyState === 1) server.close(); } catch {}
  };

  const receive = async bytes => {
    if (closed || !bytes?.length) return;
    if (writer) {
      await writer.write(bytes);
      return;
    }
    header = joinBytes(header, bytes);
    const result = parseVlessHeader(header, uuid);
    if (result.state === 'incomplete') {
      if (header.length > MAX_HEADER_BYTES) close();
      return;
    }
    if (result.state !== 'ok') {
      close();
      return;
    }
    header = new Uint8Array(0);
    socket = connect({ hostname: result.hostname, port: result.port });
    await socket.opened;
    if (closed) return;
    writer = socket.writable.getWriter();
    server.send(new Uint8Array([result.version, 0]));
    socket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (server.readyState === 1) server.send(chunk);
      },
      close,
      abort: close,
    })).catch(close);
    if (result.payload.length) await writer.write(result.payload);
  };

  let queue = Promise.resolve();
  const enqueue = value => {
    queue = queue.then(async () => receive(await messageBytes(value))).catch(close);
  };
  server.addEventListener('message', event => enqueue(event.data));
  server.addEventListener('close', close);
  server.addEventListener('error', close);
  const early = decodeEarlyData(request.headers.get('sec-websocket-protocol'));
  if (early) enqueue(early);
  return new Response(null, { status: 101, webSocket: client });
}
