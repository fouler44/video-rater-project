import type * as Party from "partykit/server";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";

type KnownMember = {
  userUuid: string;
  displayName: string;
  avatarUrl: string;
};

type ConnectedMember = KnownMember & {
  connectedAt: number;
  conn: Party.Connection;
};

type OpeningRow = {
  id: string;
  order_index: number;
  youtube_video_id: string | null;
  anime_title?: string;
  opening_label?: string;
};

type RoomStateResponse = {
  room: {
    id: string;
    name: string;
    list_id: string;
    current_opening_index: number;
    status: "waiting" | "playing" | "finished";
    host_uuid: string;
    owner_user_id: string;
  };
  openings: OpeningRow[];
  currentOpening: OpeningRow | null;
  currentOpeningRatings: Array<{ user_uuid: string; score: number; list_opening_id: string }>;
  members: Array<{ user_uuid: string; display_name: string; avatar_url: string | null }>;
};

type SessionVerifyResponse = {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string;
    role: string;
  };
  expiresAt: string;
};

type AdvanceResponse = {
  room: {
    id: string;
    status: "waiting" | "playing" | "finished";
    current_opening_index: number;
    host_uuid: string;
  };
  previousOpeningIndex: number;
  nextOpening: OpeningRow | null;
};

type ShuffleResponse = {
  room: {
    id: string;
    status: "waiting" | "playing" | "finished";
    current_opening_index: number;
    host_uuid: string;
  };
  openings: OpeningRow[];
  currentOpening: OpeningRow | null;
};

type PlayerState = {
  openingIndex: number;
  videoId: string;
  timestamp: number;
  isPlaying: boolean;
  updatedAt: number;
  sourceUserUuid: string;
  reason: string;
};

type Envelope = {
  type: string;
  payload?: any;
};

const HOST_ONLY_TYPES = new Set(["player:state", "player:sync", "opening:next", "queue:shuffle", "queue:shuffle:synced"]);
const DEFAULT_GRACE_MS = 2500;

const PlayerStateSchema = z.object({
  openingIndex: z.number().int().min(-1).optional(),
  videoId: z.string().trim().max(30).optional(),
  timestamp: z.number().min(0).optional(),
  isPlaying: z.boolean().optional(),
});

const OpeningNextSchema = z.object({
  targetIndex: z.number().int().min(0).optional(),
  finish: z.boolean().optional(),
  force: z.boolean().optional(),
  graceMs: z.number().min(0).max(10_000).optional(),
});

const QueueShuffleSchema = z.object({});

const RatingSubmittedSchema = z.object({
  openingId: z.string().uuid(),
  score: z.coerce
    .number()
    .min(1)
    .max(10)
    .refine((value) => Math.abs(value * 2 - Math.round(value * 2)) < 1e-6),
});

function normalizeHalfStepScore(value: number) {
  return Number((Math.round(Number(value) * 2) / 2).toFixed(1));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function safeJsonParse(value: string): Envelope | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function sanitizeText(value: unknown, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

export default class AnimeRoomParty implements Party.Server {
  private connectedByConnId = new Map<string, ConnectedMember>();
  private knownMembersByUser = new Map<string, KnownMember>();
  private connIdsByUser = new Map<string, Set<string>>();
  private openingsByIndex = new Map<number, OpeningRow>();

  private hostUuid = "";
  private roomStatus: "waiting" | "playing" | "finished" = "waiting";
  private currentOpeningIndex = 0;
  private playerState: PlayerState | null = null;

  private hydrated = false;
  private hydrationPromise: Promise<void> | null = null;

  constructor(readonly party: Party.Party) {}

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    try {
      await this.ensureHydrated();
    } catch {
      // Keep the socket alive even if the backend is temporarily unavailable.
    }

    const url = new URL(ctx.request.url);
    const sessionToken = sanitizeText(url.searchParams.get("sessionToken"));
    if (!sessionToken) {
      conn.close(4401, "Missing session token");
      return;
    }

    let verified: SessionVerifyResponse;
    try {
      verified = await this.fetchInternal<SessionVerifyResponse>(
        "/api/internal/auth/session/verify",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ token: sessionToken }),
        },
      );
    } catch (error: any) {
      const status = Number(error?.status || 0);
      const message = String(error?.message || "");
      const isSessionFailure = status === 401 && /invalid session token|session expired|invalid session user/i.test(message);

      console.warn(
        JSON.stringify({
          level: "warn",
          event: "partykit_auth_verify_failed",
          roomId: this.party.id,
          status,
          message,
          ts: Date.now(),
        }),
      );

      if (isSessionFailure) {
        conn.close(4401, "Invalid or expired session");
        return;
      }

      conn.close(1013, "Auth service unavailable");
      return;
    }

    const userUuid = sanitizeText(verified.user.id, conn.id);
    const displayName = sanitizeText(verified.user.displayName, "Anon");
    const avatarUrl = sanitizeText(verified.user.avatarUrl, "");

    const member: ConnectedMember = {
      userUuid,
      displayName,
      avatarUrl,
      connectedAt: Date.now(),
      conn,
    };

    this.connectedByConnId.set(conn.id, member);
    this.knownMembersByUser.set(userUuid, {
      userUuid,
      displayName,
      avatarUrl,
    });

    const connIds = this.connIdsByUser.get(userUuid) || new Set<string>();
    connIds.add(conn.id);
    this.connIdsByUser.set(userUuid, connIds);

    console.log(
      JSON.stringify({
        level: "info",
        event: "partykit_connect",
        roomId: this.party.id,
        userUuid,
        connId: conn.id,
        ts: Date.now(),
      }),
    );

    await this.ensureHostAfterMembershipChange("connect");

    conn.send(
      JSON.stringify({
        type: "room:state",
        payload: this.buildRoomStatePayload(),
      }),
    );

    if (this.playerState) {
      conn.send(
        JSON.stringify({
          type: "player:state",
          payload: {
            ...this.playerState,
            reason: "server-snapshot",
          },
        }),
      );
    }

    this.broadcastPresence();
    this.requestHostPlayerSnapshot(conn.id);
  }

  async onClose(conn: Party.Connection) {
    const disconnected = this.connectedByConnId.get(conn.id);
    if (!disconnected) return;

    this.connectedByConnId.delete(conn.id);

    const connIds = this.connIdsByUser.get(disconnected.userUuid);
    if (connIds) {
      connIds.delete(conn.id);
      if (connIds.size === 0) {
        this.connIdsByUser.delete(disconnected.userUuid);
      }
    }

    console.log(
      JSON.stringify({
        level: "info",
        event: "partykit_disconnect",
        roomId: this.party.id,
        userUuid: disconnected.userUuid,
        connId: conn.id,
        ts: Date.now(),
      }),
    );

    await this.ensureHostAfterMembershipChange("disconnect");
    this.broadcastPresence();
  }

  async onMessage(message: string, sender: Party.Connection) {
    const envelope = safeJsonParse(message);
    if (!envelope?.type) return;

    const senderMember = this.connectedByConnId.get(sender.id);
    if (!senderMember) return;

    const senderIsHost = senderMember.userUuid === this.hostUuid;
    if (HOST_ONLY_TYPES.has(envelope.type) && !senderIsHost) {
      return;
    }

    if (envelope.type === "room:request-state") {
      sender.send(
        JSON.stringify({
          type: "room:state",
          payload: this.buildRoomStatePayload(),
        }),
      );
      if (this.playerState) {
        sender.send(JSON.stringify({ type: "player:state", payload: this.playerState }));
      }
      this.requestHostPlayerSnapshot(sender.id);
      return;
    }

    if (envelope.type === "rating:submitted") {
      const parsed = RatingSubmittedSchema.safeParse(envelope.payload || {});
      if (!parsed.success) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "rating_submitted_rejected",
          roomId: this.party.id,
          payload: envelope.payload || null,
          issues: parsed.error.issues,
          ts: Date.now(),
        }));
        return;
      }

      const score = normalizeHalfStepScore(parsed.data.score);
      const openingId = parsed.data.openingId;

      this.party.broadcast(
        JSON.stringify({
          type: "rating:submitted",
          payload: {
            openingId,
            score,
            userUuid: senderMember.userUuid,
            submittedAt: Date.now(),
          },
        }),
      );
      return;
    }

    if (envelope.type === "player:state" || envelope.type === "player:sync") {
      const parsed = PlayerStateSchema.safeParse(envelope.payload || {});
      if (!parsed.success) return;

      const nextState = this.buildPlayerStateFromPayload(parsed.data, senderMember.userUuid, envelope.type);
      if (!nextState) return;
      this.playerState = nextState;

      this.party.broadcast(
        JSON.stringify({
          type: envelope.type,
          payload: nextState,
        }),
      );
      return;
    }

    if (envelope.type === "opening:next") {
      const parsed = OpeningNextSchema.safeParse(envelope.payload || {});
      if (!parsed.success) return;

      await this.handleOpeningAdvance(parsed.data, senderMember.userUuid);
      return;
    }

    if (envelope.type === "queue:shuffle") {
      const parsed = QueueShuffleSchema.safeParse(envelope.payload || {});
      if (!parsed.success) return;

      await this.handleQueueShuffle(senderMember.userUuid);
      return;
    }

    if (envelope.type === "queue:shuffle:synced") {
      // Broadcast canonical shuffle payload (already persisted by HTTP API)
      await this.ensureHydrated();

      const shuffledOpeningsArray = Array.isArray(envelope.payload?.openings)
        ? envelope.payload.openings
        : Array.from(this.openingsByIndex.values()).sort((a, b) => Number(a.order_index) - Number(b.order_index));

      this.openingsByIndex.clear();
      for (const opening of shuffledOpeningsArray) {
        this.openingsByIndex.set(Number(opening.order_index), opening);
      }

      const roomPatch = envelope.payload?.room || {};
      this.currentOpeningIndex = Number.isInteger(Number(roomPatch.current_opening_index))
        ? Number(roomPatch.current_opening_index)
        : -1;
      if (roomPatch.status) {
        this.roomStatus = roomPatch.status;
      }
      if (roomPatch.host_uuid) {
        this.hostUuid = String(roomPatch.host_uuid);
      }

      this.party.broadcast(
        JSON.stringify({
          type: "queue:shuffled",
          payload: {
            room: {
              id: this.party.id,
              status: this.roomStatus,
              current_opening_index: this.currentOpeningIndex,
              host_uuid: this.hostUuid,
            },
            txnId: envelope.payload?.txnId || "",
            queueVersion: envelope.payload?.queueVersion || Date.now(),
            openings: shuffledOpeningsArray,
            currentOpening: null,
          },
        }),
      );
      return;
    }
  }

  private buildPlayerStateFromPayload(payload: any, sourceUserUuid: string, reason = "state") {
    const openingIndexRaw = Number(payload?.openingIndex);
    const openingIndex = Number.isInteger(openingIndexRaw)
      ? openingIndexRaw
      : Number(this.currentOpeningIndex || 0);

    const currentOpening = this.openingsByIndex.get(openingIndex);
    const fallbackVideoId = currentOpening?.youtube_video_id || this.playerState?.videoId || "";
    const videoId = sanitizeText(payload?.videoId, fallbackVideoId);

    const timestampRaw = Number(payload?.timestamp);
    const timestamp = Number.isFinite(timestampRaw) ? Math.max(0, timestampRaw) : 0;

    return {
      openingIndex,
      videoId,
      timestamp,
      isPlaying: Boolean(payload?.isPlaying),
      updatedAt: Date.now(),
      sourceUserUuid,
      reason,
    } satisfies PlayerState;
  }

  private async handleOpeningAdvance(payload: any, actorUserUuid: string) {
    try {
      await this.ensureHydrated();

      const connectedUserUuids = this.getConnectedUserUuids();
      const state = await this.fetchInternal<RoomStateResponse>(`/api/internal/rooms/${this.party.id}/state`);

    // Skip checks are intentionally computed server-side with live PartyKit presence
    // so disconnected users do not block progression.
      const ratingSet = new Set((state.currentOpeningRatings || []).map((row) => row.user_uuid));
      const unratedConnected = connectedUserUuids.filter((userUuid) => !ratingSet.has(userUuid));
      const force = Boolean(payload?.force);

      if (unratedConnected.length > 0 && !force) {
        this.sendToUser(actorUserUuid, {
          type: "opening:skip:confirm-required",
          payload: {
            pendingCount: unratedConnected.length,
            pendingUserUuids: unratedConnected,
          },
        });
        return;
      }

      const targetIndexRaw = Number(payload?.targetIndex);
      const targetIndex = Number.isInteger(targetIndexRaw)
        ? targetIndexRaw
        : Number(state.room.current_opening_index || 0) + 1;

      const finish = Boolean(payload?.finish);
      const graceMsRaw = Number(payload?.graceMs || DEFAULT_GRACE_MS);
      const graceMs = clampNumber(Number.isFinite(graceMsRaw) ? graceMsRaw : DEFAULT_GRACE_MS, 2000, 3500);

      const advance = await this.fetchInternal<AdvanceResponse>(`/api/internal/rooms/${this.party.id}/advance`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actorUserUuid,
          targetIndex,
          finish,
        }),
      });

      this.roomStatus = advance.room.status;
      this.currentOpeningIndex = Number(advance.room.current_opening_index || 0);
      if (advance.room.host_uuid) {
        this.hostUuid = advance.room.host_uuid;
      }

      if (advance.nextOpening) {
        this.openingsByIndex.set(advance.nextOpening.order_index, advance.nextOpening);
      }

      const nextOpening = this.openingsByIndex.get(this.currentOpeningIndex) || null;

      this.playerState = {
        openingIndex: this.currentOpeningIndex,
        videoId: sanitizeText(nextOpening?.youtube_video_id),
        timestamp: 0,
        isPlaying: false,
        updatedAt: Date.now(),
        sourceUserUuid: actorUserUuid,
        reason: "opening-transition",
      };

      this.party.broadcast(
        JSON.stringify({
          type: "opening:next",
          payload: {
            previousOpeningIndex: advance.previousOpeningIndex,
            nextOpeningIndex: this.currentOpeningIndex,
            videoId: this.playerState.videoId,
            graceMs,
            status: this.roomStatus,
          },
        }),
      );

      this.party.broadcast(
        JSON.stringify({
          type: "room:state",
          payload: this.buildRoomStatePayload(),
        }),
      );

      this.party.broadcast(
        JSON.stringify({
          type: "player:state",
          payload: this.playerState,
        }),
      );

      if (this.roomStatus === "finished") {
        this.party.broadcast(
          JSON.stringify({
            type: "room:finished",
            payload: {
              roomId: this.party.id,
            },
          }),
        );
      }
    } catch (error: any) {
      this.sendToUser(actorUserUuid, {
        type: "opening:next:error",
        payload: {
          message: String(error?.message || "Could not advance opening"),
        },
      });
    }
  }

  private async handleQueueShuffle(actorUserUuid: string) {
    try {
      await this.ensureHydrated();

      const shuffled = await this.fetchInternal<ShuffleResponse>(`/api/internal/rooms/${this.party.id}/shuffle`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actorUserUuid,
        }),
      });

      this.roomStatus = shuffled.room.status;
      this.currentOpeningIndex = Number(shuffled.room.current_opening_index || 0);
      if (shuffled.room.host_uuid) {
        this.hostUuid = shuffled.room.host_uuid;
      }

      this.openingsByIndex.clear();
      for (const opening of shuffled.openings || []) {
        this.openingsByIndex.set(Number(opening.order_index), opening);
      }

      const currentOpening = this.openingsByIndex.get(this.currentOpeningIndex) || null;
      this.playerState = {
        openingIndex: this.currentOpeningIndex,
        videoId: sanitizeText(currentOpening?.youtube_video_id),
        timestamp: 0,
        isPlaying: false,
        updatedAt: Date.now(),
        sourceUserUuid: actorUserUuid,
        reason: "queue-shuffle",
      };

      this.party.broadcast(
        JSON.stringify({
          type: "queue:shuffled",
          payload: {
            room: shuffled.room,
            openings: shuffled.openings,
            currentOpening: shuffled.currentOpening,
          },
        }),
      );

      this.party.broadcast(
        JSON.stringify({
          type: "room:state",
          payload: this.buildRoomStatePayload(),
        }),
      );
    } catch (error: any) {
      this.sendToUser(actorUserUuid, {
        type: "queue:shuffle:error",
        payload: {
          message: String(error?.message || "Could not shuffle queue"),
        },
      });
    }
  }

  private async ensureHydrated(force = false) {
    if (this.hydrated && !force) return;
    if (this.hydrationPromise) {
      await this.hydrationPromise;
      return;
    }

    this.hydrationPromise = (async () => {
      try {
        // Rehydrate durable room state on cold start/hibernation so reconnecting
        // clients always receive a complete snapshot.
        const state = await this.fetchInternal<RoomStateResponse>(`/api/internal/rooms/${this.party.id}/state`);
        this.applyDurableState(state);
        this.hydrated = true;
      } finally {
        this.hydrationPromise = null;
      }
    })();

    await this.hydrationPromise;
  }

  private applyDurableState(state: RoomStateResponse) {
    this.roomStatus = state.room.status;
    this.currentOpeningIndex = Number(state.room.current_opening_index || 0);
    this.hostUuid = sanitizeText(state.room.host_uuid, this.hostUuid);

    this.openingsByIndex.clear();
    for (const opening of state.openings || []) {
      this.openingsByIndex.set(Number(opening.order_index), opening);
    }

    for (const row of state.members || []) {
      const userUuid = sanitizeText(row.user_uuid);
      if (!userUuid) continue;

      this.knownMembersByUser.set(userUuid, {
        userUuid,
        displayName: sanitizeText(row.display_name, "Anon"),
        avatarUrl: sanitizeText(row.avatar_url),
      });
    }

    const currentOpening = this.openingsByIndex.get(this.currentOpeningIndex) || null;
    if (!this.playerState) {
      this.playerState = {
        openingIndex: this.currentOpeningIndex,
        videoId: sanitizeText(currentOpening?.youtube_video_id),
        timestamp: 0,
        isPlaying: false,
        updatedAt: Date.now(),
        sourceUserUuid: this.hostUuid || "system",
        reason: "hydrate",
      };
    }
  }

  private async ensureHostAfterMembershipChange(reason: "connect" | "disconnect") {
    if (this.hostUuid && this.connIdsByUser.has(this.hostUuid)) {
      return;
    }

    const previousHostUuid = this.hostUuid;
    const nextHostUuid = this.getConnectedUserUuids()[0] || "";
    this.hostUuid = nextHostUuid;

    if (nextHostUuid && nextHostUuid !== previousHostUuid) {
      await this.persistHost(nextHostUuid);

      console.log(
        JSON.stringify({
          level: "info",
          event: "partykit_host_transfer",
          roomId: this.party.id,
          previousHostUuid,
          nextHostUuid,
          reason,
          ts: Date.now(),
        }),
      );
    }

    if (nextHostUuid !== previousHostUuid) {
      this.party.broadcast(
        JSON.stringify({
          type: "host:changed",
          payload: {
            hostUuid: nextHostUuid,
            previousHostUuid,
            reason,
          },
        }),
      );
    }
  }

  private async persistHost(hostUuid: string) {
    try {
      await this.fetchInternal(`/api/internal/rooms/${this.party.id}/host`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostUuid }),
      });
    } catch {
      // Keep the in-memory host assignment even if persistence temporarily fails.
    }
  }

  private buildRoomStatePayload() {
    // Presence keeps all known members, while `active` reflects current sockets.
    const members = Array.from(this.knownMembersByUser.values()).map((member) => ({
      ...member,
      active: this.connIdsByUser.has(member.userUuid),
    }));

    return {
      room: {
        id: this.party.id,
        status: this.roomStatus,
        currentOpeningIndex: this.currentOpeningIndex,
      },
      hostUuid: this.hostUuid,
      members,
      connectedUserUuids: this.getConnectedUserUuids(),
      currentOpening: this.openingsByIndex.get(this.currentOpeningIndex) || null,
      playerState: this.playerState,
    };
  }

  private broadcastPresence() {
    this.party.broadcast(
      JSON.stringify({
        type: "presence:update",
        payload: {
          hostUuid: this.hostUuid,
          members: Array.from(this.knownMembersByUser.values()).map((member) => ({
            ...member,
            active: this.connIdsByUser.has(member.userUuid),
          })),
          connectedUserUuids: this.getConnectedUserUuids(),
        },
      }),
    );
  }

  private requestHostPlayerSnapshot(targetConnectionId: string) {
    if (!this.hostUuid) return;

    const hostConn = this.getFirstConnectionForUser(this.hostUuid);
    if (!hostConn) return;

    hostConn.send(
      JSON.stringify({
        type: "player:snapshot:request",
        payload: {
          targetConnectionId,
        },
      }),
    );
  }

  private sendToUser(userUuid: string, envelope: Envelope) {
    const connIds = this.connIdsByUser.get(userUuid);
    if (!connIds || connIds.size === 0) return;

    const serialized = JSON.stringify(envelope);
    for (const connId of connIds) {
      const connected = this.connectedByConnId.get(connId);
      if (connected) {
        connected.conn.send(serialized);
      }
    }
  }

  private getFirstConnectionForUser(userUuid: string) {
    const connIds = this.connIdsByUser.get(userUuid);
    if (!connIds || connIds.size === 0) return null;

    for (const connId of connIds) {
      const connected = this.connectedByConnId.get(connId);
      if (connected) return connected.conn;
    }

    return null;
  }

  private getConnectedUserUuids() {
    const rows: Array<{ userUuid: string; connectedAt: number }> = [];

    for (const [userUuid, connIds] of this.connIdsByUser.entries()) {
      let firstConnectedAt = Number.MAX_SAFE_INTEGER;

      for (const connId of connIds) {
        const member = this.connectedByConnId.get(connId);
        if (member) {
          firstConnectedAt = Math.min(firstConnectedAt, member.connectedAt);
        }
      }

      if (firstConnectedAt !== Number.MAX_SAFE_INTEGER) {
        rows.push({ userUuid, connectedAt: firstConnectedAt });
      }
    }

    rows.sort((a, b) => a.connectedAt - b.connectedAt);
    return rows.map((row) => row.userUuid);
  }

  private getApiBaseUrl() {
    const env = this.getRequiredEnv();
    return env.apiBaseUrl.replace(/\/$/, "");
  }

  private getRequiredEnv() {
    const env = (this.party as any).env || {};
    const apiBaseUrl = sanitizeText(env.PARTYKIT_API_BASE_URL || env.API_BASE_URL);
    const internalSecret = sanitizeText(env.PARTYKIT_INTERNAL_SECRET);
    const signingSecret = sanitizeText(env.PARTYKIT_API_SIGNING_SECRET);

    if (!apiBaseUrl) {
      throw new Error("Missing required PartyKit env: PARTYKIT_API_BASE_URL");
    }

    if (!internalSecret) {
      throw new Error("Missing required PartyKit env: PARTYKIT_INTERNAL_SECRET");
    }

    if (!signingSecret) {
      throw new Error("Missing required PartyKit env: PARTYKIT_API_SIGNING_SECRET");
    }

    return {
      apiBaseUrl,
      internalSecret,
      signingSecret,
    };
  }

  private buildInternalHeaders(path: string, method: string, bodyRaw: string, extraHeaders: Record<string, string> = {}) {
    const env = this.getRequiredEnv();
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const bodyHash = createHash("sha256").update(bodyRaw).digest("hex");
    const canonical = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`;
    const signature = createHmac("sha256", env.signingSecret).update(canonical).digest("hex");

    const headers: Record<string, string> = {
      ...extraHeaders,
      "x-partykit-secret": env.internalSecret,
      "x-partykit-timestamp": timestamp,
      "x-partykit-nonce": nonce,
      "x-partykit-signature": signature,
    };

    return headers;
  }

  private async fetchInternal<T = any>(path: string, init: RequestInit = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const bodyRaw = typeof init.body === "string" ? init.body : "";

    const response = await fetch(`${this.getApiBaseUrl()}${path}`, {
      ...init,
      headers: this.buildInternalHeaders(path, method, bodyRaw, (init.headers || {}) as Record<string, string>),
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Internal API ${path} failed (${response.status}): ${body}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    return (await response.json()) as T;
  }
}

AnimeRoomParty satisfies Party.Worker;
