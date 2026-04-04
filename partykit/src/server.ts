import type * as Party from "partykit/server";

type Member = {
  userUuid: string;
  displayName: string;
};

export default class AnimeRoomParty implements Party.Server {
  members = new Map<string, Member>();
  hostUuid = "";

  constructor(readonly party: Party.Party) {}

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const userUuid = url.searchParams.get("userUuid") || conn.id;
    const displayName = url.searchParams.get("displayName") || "anon";

    this.members.set(conn.id, { userUuid, displayName });

    if (!this.hostUuid || !Array.from(this.members.values()).some((m) => m.userUuid === this.hostUuid)) {
      this.hostUuid = userUuid;
    }

    this.broadcastPresence();
  }

  onClose(conn: Party.Connection) {
    this.members.delete(conn.id);

    if (!Array.from(this.members.values()).some((m) => m.userUuid === this.hostUuid)) {
      const first = this.members.values().next().value;
      this.hostUuid = first?.userUuid || "";
    }

    this.broadcastPresence();
  }

  onMessage(message: string, sender: Party.Connection) {
    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    const senderMember = this.members.get(sender.id);
    const senderIsHost = senderMember?.userUuid === this.hostUuid;

    const hostOnlyEvents = ["player:play", "player:pause", "player:seek", "opening:next"];
    if (hostOnlyEvents.includes(parsed.type) && !senderIsHost) return;

    this.party.broadcast(JSON.stringify(parsed));
  }

  broadcastPresence() {
    const members = Array.from(this.members.values()).map((member) => ({
      userUuid: member.userUuid,
      displayName: member.displayName,
    }));

    this.party.broadcast(
      JSON.stringify({
        type: "presence:update",
        payload: {
          hostUuid: this.hostUuid,
          members,
        },
      })
    );
  }
}

AnimeRoomParty satisfies Party.Worker;
