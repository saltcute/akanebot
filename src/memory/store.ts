import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ChatMessage, MessageReaction, Platform } from "../adapters/types.ts";
import { channelKey } from "../adapters/types.ts";

export type MemoryKind = "episode" | "fact" | "claim" | "event";

export type MemoryDraft = {
    scope: string;
    kind: MemoryKind;
    /** A user key, "self", "group", or null for episodes. */
    subject: string | null;
    attributedTo: string | null;
    gist: string;
    detail: string;
    importance: number;
    salience: number;
    confidence: number;
    embedding: Float32Array | undefined;
    embeddingModel: string | null;
    sources: readonly { messageId: string; speaker: string }[];
    createdAt: number;
};

export type Memory = Omit<MemoryDraft, "sources"> & {
    id: number;
    strength: number;
    lastRecalledAt: number | null;
    recallCount: number;
    status: "active" | "archived";
    supersededBy: number | null;
};

export type MemoryState = "active" | "archived" | "replaced";

/** A memory as tools see it, without its embedding. */
export type MemoryView = Omit<Memory, "embedding" | "embeddingModel"> & { indexed: boolean };

export type MemoryQuery = {
    scope?: string | undefined;
    kind?: MemoryKind | undefined;
    state?: MemoryState | undefined;
    text?: string | undefined;
    limit: number;
    offset: number;
};

/** Where a memory came from. The message fields are null once the raw log has aged out. */
export type MemorySource = { messageId: string; speaker: string; displayName: string | null; text: string | null; sentAt: number | null };

export type RelationshipRow = {
    channel: string;
    userKey: string;
    familiarity: number;
    affinity: number;
    updatedAt: number;
    gainDay: number;
    dayGain: number;
};

type LoggedRow = {
    channel: string;
    messageId: string;
    userKey: string;
    displayName: string;
    isSelf: number;
    text: string;
    sentAt: number;
    reactions: string | null;
};

type MemoryRow = Omit<Memory, "embedding"> & { embedding: Uint8Array | null };
type MemoryViewRow = Omit<MemoryView, "indexed"> & { indexed: number };

const MEMORY_STATE_CLAUSES: Record<MemoryState, string> = {
    active: "status = 'active' AND supersededBy IS NULL",
    archived: "status = 'archived' AND supersededBy IS NULL",
    replaced: "supersededBy IS NOT NULL",
};
const MEMORY_VIEW_COLUMNS =
    "id, scope, kind, subject, attributedTo, gist, detail, importance, salience, confidence, strength, createdAt, lastRecalledAt, recallCount, status, supersededBy, embedding IS NOT NULL AS indexed";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rawLog (
    channel TEXT NOT NULL, messageId TEXT NOT NULL, userKey TEXT NOT NULL, displayName TEXT NOT NULL,
    isSelf INTEGER NOT NULL, text TEXT NOT NULL, sentAt INTEGER NOT NULL,
    attended INTEGER NOT NULL DEFAULT 0, segmented INTEGER NOT NULL DEFAULT 0, reactions TEXT,
    PRIMARY KEY (channel, messageId)
);
CREATE INDEX IF NOT EXISTS rawLogOpen ON rawLog (channel, attended, segmented, sentAt);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT, attributedTo TEXT,
    gist TEXT NOT NULL, detail TEXT NOT NULL, importance REAL NOT NULL, salience REAL NOT NULL, confidence REAL NOT NULL,
    strength REAL NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, lastRecalledAt INTEGER, recallCount INTEGER NOT NULL DEFAULT 0,
    embedding BLOB, embeddingModel TEXT, status TEXT NOT NULL DEFAULT 'active', supersededBy INTEGER
);
CREATE INDEX IF NOT EXISTS memoriesScope ON memories (scope, status);
CREATE TABLE IF NOT EXISTS memorySources (
    memoryId INTEGER NOT NULL, messageId TEXT NOT NULL, speaker TEXT NOT NULL, createdAt INTEGER NOT NULL,
    PRIMARY KEY (memoryId, messageId)
);
CREATE INDEX IF NOT EXISTS memorySourcesSpeaker ON memorySources (speaker, createdAt);
CREATE TABLE IF NOT EXISTS relationships (
    channel TEXT NOT NULL, userKey TEXT NOT NULL, familiarity REAL NOT NULL, affinity REAL NOT NULL,
    updatedAt INTEGER NOT NULL, gainDay INTEGER NOT NULL, dayGain REAL NOT NULL,
    PRIMARY KEY (channel, userKey)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** All persistent memory. The raw log in here is for tooling and extraction, and is never shown to the agent directly. */
export class MemoryStore {
    #db: DatabaseSync;

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.#db = new DatabaseSync(path);
        // The busy timeout lets `pnpm memory` run alongside the live bot.
        this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.#db.exec(SCHEMA);
        this.#addMissingColumns();
    }

    close(): void {
        this.#db.close();
    }

    logMessage(message: ChatMessage, userKey: string, attended: boolean): void {
        this.#run(
            "INSERT OR IGNORE INTO rawLog (channel, messageId, userKey, displayName, isSelf, text, sentAt, attended) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            channelKey(message),
            message.messageId,
            userKey,
            message.sender.displayName,
            message.isSelf ? 1 : 0,
            message.text,
            message.sentAt,
            attended ? 1 : 0,
        );
    }

    /** Older databases predate this column, and CREATE TABLE IF NOT EXISTS won't add it. */
    #addMissingColumns(): void {
        const columns = this.#all<{ name: string }>("PRAGMA table_info(rawLog)").map((column) => column.name);
        if (!columns.includes("reactions")) this.#db.exec("ALTER TABLE rawLog ADD COLUMN reactions TEXT");
    }

    setReactions(channel: string, messageId: string, reactions: readonly MessageReaction[]): void {
        this.#run("UPDATE rawLog SET reactions = ? WHERE channel = ? AND messageId = ?", toReactionsColumn(reactions), channel, messageId);
    }

    updateText(channel: string, messageId: string, text: string): void {
        this.#run("UPDATE rawLog SET text = ? WHERE channel = ? AND messageId = ?", text, channel, messageId);
    }

    markAttended(channel: string, messageIds: readonly string[]): void {
        for (const id of messageIds) this.#run("UPDATE rawLog SET attended = 1 WHERE channel = ? AND messageId = ?", channel, id);
    }

    recentAttended(channel: string, limit: number): ChatMessage[] {
        const rows = this.#all<LoggedRow>(
            "SELECT * FROM rawLog WHERE channel = ? AND attended = 1 ORDER BY sentAt DESC, rowid DESC LIMIT ?",
            channel,
            limit,
        );
        return rows.reverse().map(toChatMessage);
    }

    /** Attended messages not yet digested into memories, oldest first. */
    openSegment(channel: string): ChatMessage[] {
        return this.#all<LoggedRow>("SELECT * FROM rawLog WHERE channel = ? AND attended = 1 AND segmented = 0 ORDER BY sentAt, rowid", channel).map(
            toChatMessage,
        );
    }

    channelsWithOpenSegments(): string[] {
        return this.#all<{ channel: string }>("SELECT DISTINCT channel FROM rawLog WHERE attended = 1 AND segmented = 0").map((row) => row.channel);
    }

    markSegmented(channel: string, messageIds: readonly string[]): void {
        for (const id of messageIds) this.#run("UPDATE rawLog SET segmented = 1 WHERE channel = ? AND messageId = ?", channel, id);
    }

    /** Which of these messages still exist, since someone may have opted out while extraction was running. */
    stillLogged(channel: string, messageIds: readonly string[]): Set<string> {
        const present = new Set<string>();
        for (const id of messageIds) {
            if (this.#all("SELECT 1 FROM rawLog WHERE channel = ? AND messageId = ?", channel, id).length > 0) present.add(id);
        }
        return present;
    }

    addMemory(draft: MemoryDraft): number {
        const result = this.#run(
            `INSERT INTO memories (scope, kind, subject, attributedTo, gist, detail, importance, salience, confidence, createdAt, embedding, embeddingModel)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            draft.scope,
            draft.kind,
            draft.subject,
            draft.attributedTo,
            draft.gist,
            draft.detail,
            draft.importance,
            draft.salience,
            draft.confidence,
            draft.createdAt,
            toBlob(draft.embedding),
            draft.embedding ? draft.embeddingModel : null,
        );
        const id = Number(result.lastInsertRowid);
        for (const source of draft.sources) {
            this.#run(
                "INSERT OR IGNORE INTO memorySources (memoryId, messageId, speaker, createdAt) VALUES (?, ?, ?, ?)",
                id,
                source.messageId,
                source.speaker,
                draft.createdAt,
            );
        }
        return id;
    }

    get(id: number): Memory | undefined {
        const [row] = this.#all<MemoryRow>("SELECT * FROM memories WHERE id = ?", id);
        return row ? toMemory(row) : undefined;
    }

    /** Memories that can be recalled: active and not replaced by a newer one. */
    activeIn(scope: string): Memory[] {
        return this.#all<MemoryRow>("SELECT * FROM memories WHERE scope = ? AND status = 'active' AND supersededBy IS NULL", scope).map(toMemory);
    }

    all(): Memory[] {
        return this.#all<MemoryRow>("SELECT * FROM memories ORDER BY id").map(toMemory);
    }

    /** One page of memories, newest first. */
    browse(query: MemoryQuery): { memories: MemoryView[]; total: number } {
        const clauses: string[] = [];
        const parameters: SQLInputValue[] = [];
        if (query.scope) {
            clauses.push("scope = ?");
            parameters.push(query.scope);
        }
        if (query.kind) {
            clauses.push("kind = ?");
            parameters.push(query.kind);
        }
        if (query.state) clauses.push(MEMORY_STATE_CLAUSES[query.state]);
        if (query.text) {
            clauses.push("(gist LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
            const pattern = `%${query.text.replace(/[\\%_]/g, "\\$&")}%`;
            parameters.push(pattern, pattern);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const [count] = this.#all<{ total: number }>(`SELECT COUNT(*) AS total FROM memories ${where}`, ...parameters);
        const rows = this.#all<MemoryViewRow>(
            `SELECT ${MEMORY_VIEW_COLUMNS} FROM memories ${where} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
            ...parameters,
            query.limit,
            query.offset,
        );
        return { memories: rows.map(toMemoryView), total: count?.total ?? 0 };
    }

    view(id: number): MemoryView | undefined {
        const [row] = this.#all<MemoryViewRow>(`SELECT ${MEMORY_VIEW_COLUMNS} FROM memories WHERE id = ?`, id);
        return row ? toMemoryView(row) : undefined;
    }

    sourcesOf(id: number): MemorySource[] {
        return this.#all<MemorySource>(
            `SELECT s.messageId, s.speaker, r.displayName, r.text, r.sentAt FROM memorySources s
             JOIN memories m ON m.id = s.memoryId
             LEFT JOIN rawLog r ON r.channel = m.scope AND r.messageId = s.messageId
             WHERE s.memoryId = ? ORDER BY r.sentAt, s.messageId`,
            id,
        );
    }

    scopes(): string[] {
        return this.#all<{ scope: string }>("SELECT DISTINCT scope FROM memories").map((row) => row.scope);
    }

    sourceSpeakers(id: number): string[] {
        return this.#all<{ speaker: string }>("SELECT DISTINCT speaker FROM memorySources WHERE memoryId = ?", id).map((row) => row.speaker);
    }

    /** Recalling makes a memory easier to find again. It deliberately never changes how much it is believed. */
    noteRecalled(id: number, now: number, strengthGain: number, maxStrength: number): void {
        this.#run(
            "UPDATE memories SET strength = MIN(?, strength + ?), lastRecalledAt = ?, recallCount = recallCount + 1 WHERE id = ?",
            maxStrength,
            strengthGain,
            now,
            id,
        );
    }

    setStrength(id: number, strength: number): void {
        this.#run("UPDATE memories SET strength = ? WHERE id = ?", strength, id);
    }

    setStatus(id: number, status: "active" | "archived"): void {
        this.#run("UPDATE memories SET status = ? WHERE id = ?", status, id);
    }

    setEmbedding(id: number, embedding: Float32Array, model: string): void {
        this.#run("UPDATE memories SET embedding = ?, embeddingModel = ? WHERE id = ?", toBlob(embedding), model, id);
    }

    /** New text clears the embedding, because it no longer describes the memory. */
    edit(id: number, fields: { gist?: string; detail?: string; importance?: number }): void {
        const current = this.get(id);
        if (!current) return;
        const gist = fields.gist ?? current.gist;
        const detail = fields.detail ?? current.detail;
        this.#run("UPDATE memories SET gist = ?, detail = ?, importance = ? WHERE id = ?", gist, detail, fields.importance ?? current.importance, id);
        if (gist !== current.gist || detail !== current.detail)
            this.#run("UPDATE memories SET embedding = NULL, embeddingModel = NULL WHERE id = ?", id);
    }

    /** Reversible: clearing the link brings the old memory back. */
    supersede(oldId: number, newId: number | null): void {
        this.#run("UPDATE memories SET supersededBy = ? WHERE id = ?", newId, oldId);
    }

    adoptSources(fromId: number, intoId: number): void {
        this.#run(
            "INSERT OR IGNORE INTO memorySources SELECT ?, messageId, speaker, createdAt FROM memorySources WHERE memoryId = ?",
            intoId,
            fromId,
        );
    }

    promote(id: number, confidence: number): void {
        this.#run("UPDATE memories SET kind = 'fact', confidence = ? WHERE id = ?", confidence, id);
    }

    forget(id: number): void {
        this.#run("UPDATE memories SET supersededBy = NULL WHERE supersededBy = ?", id);
        this.#run("DELETE FROM memorySources WHERE memoryId = ?", id);
        this.#run("DELETE FROM memories WHERE id = ?", id);
    }

    /** Removes everything derived from a person, including shared summaries they contributed to. Returns how many memories went. */
    forgetUser(user: string): number {
        const ids = this.#memoriesDerivedFrom(user);
        for (const id of ids) this.forget(id);
        this.#run("DELETE FROM rawLog WHERE userKey = ?", user);
        this.#removeReactionsBy(user);
        this.#run("DELETE FROM relationships WHERE userKey = ?", user);
        return ids.size;
    }

    /** What `forgetUser` would delete. */
    forgetImpact(user: string): { memories: number; messages: number } {
        const [row] = this.#all<{ total: number }>("SELECT COUNT(*) AS total FROM rawLog WHERE userKey = ?", user);
        return { memories: this.#memoriesDerivedFrom(user).size, messages: row?.total ?? 0 };
    }

    #memoriesDerivedFrom(user: string): Set<number> {
        // Things others said about this person are stored under their display name, so those go too.
        const names = this.#all<{ displayName: string }>("SELECT DISTINCT displayName FROM rawLog WHERE userKey = ?", user).map(
            (row) => `name:${row.displayName}`,
        );
        const ids = this.#all<{ id: number }>(
            `SELECT id FROM memories WHERE subject = ?1 OR attributedTo = ?1
             UNION SELECT memoryId AS id FROM memorySources WHERE speaker = ?1`,
            user,
        ).map((row) => row.id);
        for (const name of names) ids.push(...this.#all<{ id: number }>("SELECT id FROM memories WHERE subject = ?", name).map((row) => row.id));
        return new Set(ids);
    }

    #removeReactionsBy(user: string): void {
        const rows = this.#all<{ channel: string; messageId: string; reactions: string }>(
            "SELECT channel, messageId, reactions FROM rawLog WHERE instr(reactions, ?) > 0",
            JSON.stringify(user),
        );
        for (const row of rows) {
            const kept = (JSON.parse(row.reactions) as MessageReaction[]).filter((reaction) => reaction.byUser !== user);
            this.setReactions(row.channel, row.messageId, kept);
        }
    }

    displayNameOf(user: string): string | undefined {
        return this.#all<{ displayName: string }>("SELECT displayName FROM rawLog WHERE userKey = ? ORDER BY sentAt DESC LIMIT 1", user)[0]
            ?.displayName;
    }

    writesSince(speaker: string, since: number): number {
        const [row] = this.#all<{ total: number }>(
            "SELECT COUNT(DISTINCT memoryId) AS total FROM memorySources s JOIN memories m ON m.id = s.memoryId WHERE speaker = ? AND s.createdAt >= ? AND m.kind != 'episode'",
            speaker,
            since,
        );
        return row?.total ?? 0;
    }

    purgeRawBefore(cutoff: number): void {
        this.#run("DELETE FROM rawLog WHERE sentAt < ? AND (segmented = 1 OR attended = 0)", cutoff);
    }

    getRelationship(channel: string, user: string): RelationshipRow | undefined {
        return this.#all<RelationshipRow>("SELECT * FROM relationships WHERE channel = ? AND userKey = ?", channel, user)[0];
    }

    saveRelationship(row: RelationshipRow): void {
        this.#run(
            `INSERT INTO relationships (channel, userKey, familiarity, affinity, updatedAt, gainDay, dayGain) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (channel, userKey) DO UPDATE SET familiarity = excluded.familiarity, affinity = excluded.affinity,
             updatedAt = excluded.updatedAt, gainDay = excluded.gainDay, dayGain = excluded.dayGain`,
            row.channel,
            row.userKey,
            row.familiarity,
            row.affinity,
            row.updatedAt,
            row.gainDay,
            row.dayGain,
        );
    }

    getMeta(key: string): string | undefined {
        return this.#all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value;
    }

    setMeta(key: string, value: string): void {
        this.#run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
    }

    #run(sql: string, ...parameters: SQLInputValue[]) {
        return this.#db.prepare(sql).run(...parameters);
    }

    #all<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
        return this.#db.prepare(sql).all(...parameters) as T[];
    }
}

function toBlob(embedding: Float32Array | undefined): Uint8Array | null {
    return embedding ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null;
}

function toMemory(row: MemoryRow): Memory {
    // Copied first, because a Float32Array needs an aligned buffer and SQLite's blob may not be.
    return { ...row, embedding: row.embedding ? new Float32Array(row.embedding.slice().buffer) : undefined };
}

function toMemoryView(row: MemoryViewRow): MemoryView {
    return { ...row, indexed: row.indexed === 1 };
}

function toReactionsColumn(reactions: readonly MessageReaction[]): string | null {
    return reactions.length > 0 ? JSON.stringify(reactions) : null;
}

function toChatMessage(row: LoggedRow): ChatMessage {
    const separator = row.channel.indexOf(":");
    return {
        platform: row.channel.slice(0, separator) as Platform,
        channelId: row.channel.slice(separator + 1),
        messageId: row.messageId,
        sender: { id: row.userKey.slice(row.userKey.indexOf(":") + 1), displayName: row.displayName, isBot: false },
        text: row.text,
        ...(row.reactions ? { reactions: JSON.parse(row.reactions) as MessageReaction[] } : {}),
        sentAt: row.sentAt,
        mentionsSelf: false,
        repliesToSelf: false,
        isSelf: row.isSelf === 1,
        isBacklog: false,
    };
}
