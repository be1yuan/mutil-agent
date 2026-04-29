/**
 * Server-Sent Events (SSE) utilities.
 *
 * Provides helpers for setting up SSE connections and sending events
 * to connected clients. Uses raw Node.js ServerResponse objects.
 */

import type { ServerResponse } from "node:http";

// ── SSE client management ──

/** Set up a response as an SSE stream */
export function initSSE(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();
}

/** Send an SSE event to a client */
export function sendSSE(
  res: ServerResponse,
  event: string,
  data: unknown
): void {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client disconnected — ignore
  }
}

/** Send a keep-alive comment (prevents proxy timeout) */
export function sendSSEHeartbeat(res: ServerResponse): void {
  if (res.writableEnded) return;
  try {
    res.write(": heartbeat\n\n");
  } catch {
    // Client disconnected
  }
}

/** Close an SSE connection gracefully */
export function closeSSE(res: ServerResponse): void {
  if (res.writableEnded) return;
  try {
    sendSSE(res, "done", {});
    res.end();
  } catch {
    // Already closed
  }
}

/** Manage a set of SSE clients with heartbeat and cleanup */
export class SSEClientSet {
  private clients = new Set<ServerResponse>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(private heartbeatIntervalMs: number = 30_000) {}

  /** Add a client and start heartbeat if this is the first */
  add(res: ServerResponse): void {
    this.clients.add(res);

    // Clean up on client disconnect
    res.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this.stopHeartbeat();
      }
    });

    // Start heartbeat if this is the first client
    if (this.clients.size === 1) {
      this.startHeartbeat();
    }
  }

  /** Broadcast an event to all connected clients */
  broadcast(event: string, data: unknown): void {
    for (const client of this.clients) {
      sendSSE(client, event, data);
    }
  }

  /** Close all SSE connections */
  closeAll(): void {
    this.stopHeartbeat();
    for (const client of this.clients) {
      closeSSE(client);
    }
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        sendSSEHeartbeat(client);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
