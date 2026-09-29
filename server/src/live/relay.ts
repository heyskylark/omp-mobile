const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
type SocketData = { roomId: string; role: "host" | "guest"; peerId: number };
type Socket = Bun.ServerWebSocket<SocketData>;
type Room = { host: Socket; guests: Map<number, Socket>; nextPeerId: number };

export interface LocalRelay {
	url: string;
	port: number;
	stop(): void;
}

export function startLocalRelay(port: number): LocalRelay {
	const rooms = new Map<string, Room>();
	const server = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port,
		fetch(request, bun) {
			const url = new URL(request.url);
			const match = ROOM_PATH.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) return new Response("not found", { status: 404 });
			if (bun.upgrade(request, { data: { roomId: match[1]!, role, peerId: 0 } })) return;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				if (ws.data.role === "host") {
					if (rooms.has(ws.data.roomId)) ws.close(4009, "host exists");
					else rooms.set(ws.data.roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					return;
				}
				const room = rooms.get(ws.data.roomId);
				if (!room) {
					ws.close(4004, "no such room");
					return;
				}
				ws.data.peerId = room.nextPeerId++;
				room.guests.set(ws.data.peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: ws.data.peerId }));
			},
			message(ws, message) {
				if (typeof message === "string") return;
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
				if (bytes.byteLength < 4) return;
				if (ws.data.role === "host") {
					const target = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
					if (target === 0) for (const guest of room.guests.values()) guest.send(message);
					else room.guests.get(target)?.send(message);
				} else {
					new DataView(bytes.buffer, bytes.byteOffset, 4).setUint32(0, ws.data.peerId, false);
					room.host.send(message);
				}
			},
			close(ws) {
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host" && room.host === ws) {
					rooms.delete(ws.data.roomId);
					for (const guest of room.guests.values()) {
						guest.send(JSON.stringify({ t: "room-closed" }));
						guest.close(4001, "room closed");
					}
				} else if (room.guests.delete(ws.data.peerId))
					room.host.send(JSON.stringify({ t: "peer-left", peer: ws.data.peerId }));
			},
		},
	});
	const boundPort = server.port ?? port;
	return {
		url: `ws://127.0.0.1:${boundPort}`,
		port: boundPort,
		stop() {
			for (const room of rooms.values()) {
				room.host.close(1001, "relay stopping");
				for (const guest of room.guests.values()) guest.close(1001, "relay stopping");
			}
			rooms.clear();
			server.stop(true);
		},
	};
}
