import { DurableObject } from "cloudflare:workers";
import type { MailRealtimeEvent } from "flary/mail";

type SocketAttachment = {
  readonly userId: string;
  readonly mailboxId: string;
  readonly connectedAt: string;
};

export class MailRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const userId = request.headers.get("x-flary-mail-user");
    const mailboxId = request.headers.get("x-flary-mail-mailbox");
    if (!userId || !mailboxId)
      return new Response("Unauthorized.", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      userId,
      mailboxId,
      connectedAt: new Date().toISOString(),
    } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "mail.ready", mailboxId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(event: MailRealtimeEvent): Promise<number> {
    const payload = JSON.stringify(event);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.mailboxId !== event.mailboxId) continue;
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        socket.close(1011, "Delivery failed");
      }
    }
    return delivered;
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message === "string" && message === "ping") socket.send("pong");
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string
  ): Promise<void> {
    socket.close(code, reason);
  }
}
