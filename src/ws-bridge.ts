import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';

const wss = new WebSocketServer({ noServer: true });

export function acceptWebSocket(req: IncomingMessage, socket: Socket, head: Buffer): Promise<WsSocket> {
  return new Promise(resolve => wss.handleUpgrade(req, socket, head, ws => resolve(ws)));
}

/** Blind byte-for-byte bridge between an accepted WebSocket and a raw TCP target: no
 * protocol (e.g. RFB/VNC) awareness on this side, matching how websockify works. The far
 * ends (a VNC client and the worker's VNC server) perform their own handshake/auth. */
export function bridgeWebSocketToTcp(ws: WsSocket, target: Socket) {
  ws.on('message', data => target.write(data as Buffer));
  target.on('data', chunk => ws.send(chunk));
  const cleanup = () => { ws.close(); target.destroy(); };
  ws.on('close', cleanup); ws.on('error', cleanup);
  target.on('close', cleanup); target.on('error', cleanup);
}
