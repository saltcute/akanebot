import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ChatMessage, MessageReaction, Platform, QuotedMessage } from "../adapters/types.ts";
import { channelKey } from "../adapters/types.ts";
import { NO_LINKS, type People } from "../control/people.ts";

export type MemoryKind = "episode" | "fact" | "claim" | "event";

/** "group" stays where it was learned, and "shared" may come to mind in other groups. `scope` is always the group it came from. */
export type MemoryReach = "group" | "shared";

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
    /** Stays in its group unless something decided otherwise. */
    reach?: MemoryReach;
};

export type Memory = Omit<MemoryDraft, "sources" | "reach"> & {
    id: number;
    reach: MemoryReach;
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
    reach?: MemoryReach | undefined;
    state?: MemoryState | undefined;
    text?: string | undefined;
    limit: number;
    offset: number;
};

/** Where a memory came from. The message fields are null once the raw log has aged out. */
export type MemorySource = { messageId: string; speaker: string; displayName: string | null; text: string | null; sentAt: number | null };

export type LogQuery = { channel?: string | undefined; users?: readonly string[]; text?: string | undefined; limit: number; offset: number };

/** A raw log line as the operator sees it. */
export type LoggedMessage = {
    channel: string;
    messageId: string;
    senderKey: string;
    senderName: string;
    isSelf: boolean;
    attended: boolean;
    digested: boolean;
    text: string;
    sentAt: number;
    quoted: { senderName: string; text: string } | undefined;
};

/** A picture she decided to keep. `scope` is the group it came from and `userKey` whoever posted it, so it goes if they're forgotten. */
export type SavedImageDraft = {
    sha256: string;
    scope: string;
    messageId: string;
    userKey: string;
    mime: string;
    bytes: Uint8Array;
    description: string;
    /** The moment it would suit, in a few words. */
    useFor: string;
    appeal: number;
    embedding: Float32Array | undefined;
    embeddingModel: string | null;
    savedAt: number;
    /** Set when the picture is only a link, as Discord's GIF picker posts them. `bytes` is then empty. */
    link?: string | undefined;
};

/** A saved picture without its bytes, which are only loaded to send it. */
export type SavedImage = Omit<SavedImageDraft, "bytes" | "sha256" | "link"> & {
    link: string | null;
    id: number;
    size: number;
    lastSentAt: number | null;
    timesSent: number;
};

/** A saved picture as tools see it, without its embedding. */
export type SavedImageView = Omit<SavedImage, "embedding" | "embeddingModel">;

export type SavedImageQuery = { scope?: string | undefined; users?: readonly string[]; text?: string | undefined; limit: number; offset: number };

export type MemoryStats = { active: number; archived: number; replaced: number; unindexed: number; messages: number };

export type LoggedSpeaker = { userKey: string; displayName: string; messages: number; lastSeen: number };

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
    attended: number;
    segmented: number;
    channel: string;
    messageId: string;
    userKey: string;
    displayName: string;
    isSelf: number;
    text: string;
    sentAt: number;
    reactions: string | null;
    replyTo: string | null;
};

type SavedImageRow = Omit<SavedImage, "embedding"> & { embedding: Uint8Array | null };
type MemoryRow = Omit<Memory, "embedding"> & { embedding: Uint8Array | null };
type MemoryViewRow = Omit<MemoryView, "indexed"> & { indexed: number };

const MEMORY_STATE_CLAUSES: Record<MemoryState, string> = {
    active: "status = 'active' AND supersededBy IS NULL",
    archived: "status = 'archived' AND supersededBy IS NULL",
    replaced: "supersededBy IS NOT NULL",
};
const MEMORY_VIEW_COLUMNS =
    "id, scope, reach, kind, subject, attributedTo, gist, detail, importance, salience, confidence, strength, createdAt, lastRecalledAt, recallCount, status, supersededBy, embedding IS NOT NULL AS indexed";

const SAVED_IMAGE_VIEW_COLUMNS =
    "id, scope, messageId, userKey, mime, length(bytes) AS size, description, useFor, appeal, savedAt, lastSentAt, timesSent, link";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rawLog (
    channel TEXT NOT NULL, messageId TEXT NOT NULL, userKey TEXT NOT NULL, displayName TEXT NOT NULL,
    isSelf INTEGER NOT NULL, text TEXT NOT NULL, sentAt INTEGER NOT NULL,
    attended INTEGER NOT NULL DEFAULT 0, segmented INTEGER NOT NULL DEFAULT 0, reactions TEXT, replyTo TEXT,
    PRIMARY KEY (channel, messageId)
);
CREATE INDEX IF NOT EXISTS rawLogOpen ON rawLog (channel, attended, segmented, sentAt);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT, attributedTo TEXT,
    gist TEXT NOT NULL, detail TEXT NOT NULL, importance REAL NOT NULL, salience REAL NOT NULL, confidence REAL NOT NULL,
    strength REAL NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, lastRecalledAt INTEGER, recallCount INTEGER NOT NULL DEFAULT 0,
    embedding BLOB, embeddingModel TEXT, status TEXT NOT NULL DEFAULT 'active', supersededBy INTEGER,
    reach TEXT NOT NULL DEFAULT 'group'
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
CREATE TABLE IF NOT EXISTS savedImages (
    id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, messageId TEXT NOT NULL, userKey TEXT NOT NULL,
    mime TEXT NOT NULL, bytes BLOB NOT NULL, description TEXT NOT NULL, useFor TEXT NOT NULL, appeal REAL NOT NULL,
    embedding BLOB, embeddingModel TEXT, savedAt INTEGER NOT NULL, lastSentAt INTEGER, timesSent INTEGER NOT NULL DEFAULT 0, link TEXT
);
CREATE INDEX IF NOT EXISTS savedImagesUser ON savedImages (userKey, savedAt);
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
            "INSERT OR IGNORE INTO rawLog (channel, messageId, userKey, displayName, isSelf, text, sentAt, attended, replyTo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            channelKey(message),
            message.messageId,
            userKey,
            message.sender.displayName,
            message.isSelf ? 1 : 0,
            message.text,
            message.sentAt,
            attended ? 1 : 0,
            message.replyTo ? JSON.stringify(message.replyTo) : null,
        );
    }

    /** Older databases predate these columns, and CREATE TABLE IF NOT EXISTS won't add them. */
    #addMissingColumns(): void {
        const columns = this.#all<{ name: string }>("PRAGMA table_info(rawLog)").map((column) => column.name);
        if (!columns.includes("reactions")) this.#db.exec("ALTER TABLE rawLog ADD COLUMN reactions TEXT");
        if (!columns.includes("replyTo")) this.#db.exec("ALTER TABLE rawLog ADD COLUMN replyTo TEXT");
        // Everything remembered before sharing existed stays in its own group.
        const memoryColumns = this.#all<{ name: string }>("PRAGMA table_info(memories)").map((column) => column.name);
        if (!memoryColumns.includes("reach")) this.#db.exec("ALTER TABLE memories ADD COLUMN reach TEXT NOT NULL DEFAULT 'group'");
        const imageColumns = this.#all<{ name: string }>("PRAGMA table_info(savedImages)").map((column) => column.name);
        if (!imageColumns.includes("link")) this.#db.exec("ALTER TABLE savedImages ADD COLUMN link TEXT");
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

    /** One page of the raw log, newest first. Operator tooling only: this never reaches the agent. */
    browseLog(query: LogQuery): { messages: LoggedMessage[]; total: number } {
        const clauses: string[] = [];
        const parameters: SQLInputValue[] = [];
        if (query.channel) {
            clauses.push("channel = ?");
            parameters.push(query.channel);
        }
        if (query.users) {
            clauses.push(`userKey IN (${query.users.map(() => "?").join(", ")})`);
            parameters.push(...query.users);
        }
        if (query.text) {
            clauses.push("text LIKE ? ESCAPE '\\'");
            parameters.push(`%${query.text.replace(/[\\%_]/g, "\\$&")}%`);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const [count] = this.#all<{ total: number }>(`SELECT COUNT(*) AS total FROM rawLog ${where}`, ...parameters);
        const rows = this.#all<LoggedRow>(
            `SELECT * FROM rawLog ${where} ORDER BY sentAt DESC, rowid DESC LIMIT ? OFFSET ?`,
            ...parameters,
            query.limit,
            query.offset,
        );
        return { messages: rows.map(toLoggedMessage), total: count?.total ?? 0 };
    }

    /** Also clears the text quoted in replies to it. Memory sources stay, because forgetting and write quotas rely on them. False if it wasn't logged. */
    deleteLogged(channel: string, messageId: string): boolean {
        this.#run("DELETE FROM savedImages WHERE scope = ? AND messageId = ?", channel, messageId);
        const { changes } = this.#run("DELETE FROM rawLog WHERE channel = ? AND messageId = ?", channel, messageId);
        if (changes === 0) return false;
        this.#run("UPDATE rawLog SET replyTo = NULL WHERE channel = ? AND json_extract(replyTo, '$.messageId') = ?", channel, messageId);
        return true;
    }

    logChannels(): string[] {
        return this.#all<{ channel: string }>("SELECT DISTINCT channel FROM rawLog ORDER BY channel").map((row) => row.channel);
    }

    stats(): MemoryStats {
        const [memories] = this.#all<Omit<MemoryStats, "messages">>(
            `SELECT COALESCE(SUM(${MEMORY_STATE_CLAUSES.active}), 0) AS active, COALESCE(SUM(${MEMORY_STATE_CLAUSES.archived}), 0) AS archived,
             COALESCE(SUM(${MEMORY_STATE_CLAUSES.replaced}), 0) AS replaced,
             COALESCE(SUM(${MEMORY_STATE_CLAUSES.active} AND embedding IS NULL), 0) AS unindexed FROM memories`,
        );
        const [log] = this.#all<{ messages: number }>("SELECT COUNT(*) AS messages FROM rawLog");
        return {
            active: memories?.active ?? 0,
            archived: memories?.archived ?? 0,
            replaced: memories?.replaced ?? 0,
            unindexed: memories?.unindexed ?? 0,
            messages: log?.messages ?? 0,
        };
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
            `INSERT INTO memories (scope, reach, kind, subject, attributedTo, gist, detail, importance, salience, confidence, createdAt, embedding, embeddingModel)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            draft.scope,
            draft.reach ?? "group",
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

    /** Memories allowed out of their group, from every group. */
    activeShared(): Memory[] {
        return this.#all<MemoryRow>("SELECT * FROM memories WHERE reach = 'shared' AND status = 'active' AND supersededBy IS NULL").map(toMemory);
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
        if (query.reach) {
            clauses.push("reach = ?");
            parameters.push(query.reach);
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

    setReach(id: number, reach: MemoryReach): void {
        this.#run("UPDATE memories SET reach = ? WHERE id = ?", reach, id);
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
    forgetUser(user: string, people: People = NO_LINKS): number {
        const ids = this.#memoriesDerivedFrom(user, people);
        for (const id of ids) this.forget(id);
        for (const account of people.accountsOf(user)) {
            this.#run("DELETE FROM rawLog WHERE userKey = ?", account);
            this.#run("UPDATE rawLog SET replyTo = NULL WHERE json_extract(replyTo, '$.byUser') = ?", account);
            this.#removeReactionsBy(account);
            this.#run("DELETE FROM relationships WHERE userKey = ?", account);
            this.#run("DELETE FROM savedImages WHERE userKey = ?", account);
        }
        return ids.size;
    }

    /** What `forgetUser` would delete. */
    forgetImpact(user: string, people: People = NO_LINKS): { memories: number; messages: number; images: number } {
        const accounts = people.accountsOf(user);
        const messages = accounts.reduce((total, account) => {
            const [row] = this.#all<{ total: number }>("SELECT COUNT(*) AS total FROM rawLog WHERE userKey = ?", account);
            return total + (row?.total ?? 0);
        }, 0);
        return { memories: this.#memoriesDerivedFrom(user, people).size, messages, images: this.savedImagesSince(accounts, 0) };
    }

    #memoriesDerivedFrom(user: string, people: People): Set<number> {
        const ids = new Set<number>();
        const configuredName = people.nameOf(user);
        const names = new Set(configuredName ? [configuredName] : []);
        for (const account of people.accountsOf(user)) {
            // Things others said about this person are stored under their display name, so those go too.
            for (const { displayName } of this.#all<{ displayName: string }>("SELECT DISTINCT displayName FROM rawLog WHERE userKey = ?", account)) {
                names.add(displayName);
            }
            const derived = this.#all<{ id: number }>(
                `SELECT id FROM memories WHERE subject = ?1 OR attributedTo = ?1
                 UNION SELECT memoryId AS id FROM memorySources WHERE speaker = ?1`,
                account,
            );
            for (const { id } of derived) ids.add(id);
        }
        for (const name of names)
            for (const { id } of this.#all<{ id: number }>("SELECT id FROM memories WHERE subject = ?", `name:${name}`)) ids.add(id);
        for (const alias of people.aliasesOf(user)) {
            for (const { id } of this.#all<{ id: number }>("SELECT id FROM memories WHERE subject = ? COLLATE NOCASE", `name:${alias}`)) ids.add(id);
        }
        return ids;
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

    /** Every row for these accounts, in any group. */
    relationshipsOf(accounts: readonly string[]): RelationshipRow[] {
        return accounts.flatMap((account) => this.#all<RelationshipRow>("SELECT * FROM relationships WHERE userKey = ?", account));
    }

    allRelationships(): RelationshipRow[] {
        return this.#all<RelationshipRow>("SELECT * FROM relationships");
    }

    /** Everyone with a logged message, under the name they used most recently. Group events and her own lines aren't anyone. */
    loggedSpeakers(): LoggedSpeaker[] {
        return this.#all<LoggedSpeaker>(
            "SELECT userKey, displayName, COUNT(*) AS messages, MAX(sentAt) AS lastSeen FROM rawLog WHERE isSelf = 0 AND userKey NOT LIKE '%:event' GROUP BY userKey",
        );
    }

    deleteRelationships(accounts: readonly string[]): void {
        for (const account of accounts) this.#run("DELETE FROM relationships WHERE userKey = ?", account);
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

    hasSavedImage(sha256: string): boolean {
        return this.#all("SELECT 1 FROM savedImages WHERE sha256 = ?", sha256).length > 0;
    }

    /** Undefined if she already has this exact picture. */
    saveImage(draft: SavedImageDraft): number | undefined {
        const result = this.#run(
            `INSERT OR IGNORE INTO savedImages (sha256, scope, messageId, userKey, mime, bytes, description, useFor, appeal, embedding, embeddingModel, savedAt, link)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            draft.sha256,
            draft.scope,
            draft.messageId,
            draft.userKey,
            draft.mime,
            draft.bytes,
            draft.description,
            draft.useFor,
            draft.appeal,
            toBlob(draft.embedding),
            draft.embedding ? draft.embeddingModel : null,
            draft.savedAt,
            draft.link ?? null,
        );
        return result.changes === 0 ? undefined : Number(result.lastInsertRowid);
    }

    /** Everything she has saved, with no image data. */
    savedImages(): SavedImage[] {
        return this.#all<SavedImageRow>(
            `SELECT id, scope, messageId, userKey, mime, length(bytes) AS size, description, useFor, appeal, embedding, embeddingModel, savedAt, lastSentAt, timesSent, link
             FROM savedImages ORDER BY id`,
        ).map((row) => ({ ...row, embedding: toEmbedding(row.embedding) }));
    }

    savedImage(id: number): SavedImageView | undefined {
        return this.#all<SavedImageView>(`SELECT ${SAVED_IMAGE_VIEW_COLUMNS} FROM savedImages WHERE id = ?`, id)[0];
    }

    /** One page, newest first. Operator tooling only. */
    browseSavedImages(query: SavedImageQuery): { images: SavedImageView[]; total: number } {
        const clauses: string[] = [];
        const parameters: SQLInputValue[] = [];
        if (query.scope) {
            clauses.push("scope = ?");
            parameters.push(query.scope);
        }
        if (query.users) {
            clauses.push(`userKey IN (${query.users.map(() => "?").join(", ")})`);
            parameters.push(...query.users);
        }
        if (query.text) {
            const pattern = `%${query.text.replace(/[\\%_]/g, "\\$&")}%`;
            clauses.push("(description LIKE ? ESCAPE '\\' OR useFor LIKE ? ESCAPE '\\')");
            parameters.push(pattern, pattern);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const [count] = this.#all<{ total: number }>(`SELECT COUNT(*) AS total FROM savedImages ${where}`, ...parameters);
        const images = this.#all<SavedImageView>(
            `SELECT ${SAVED_IMAGE_VIEW_COLUMNS} FROM savedImages ${where} ORDER BY savedAt DESC, id DESC LIMIT ? OFFSET ?`,
            ...parameters,
            query.limit,
            query.offset,
        );
        return { images, total: count?.total ?? 0 };
    }

    savedImageScopes(): string[] {
        return this.#all<{ scope: string }>("SELECT DISTINCT scope FROM savedImages ORDER BY scope").map((row) => row.scope);
    }

    /** New words replace the embedding too, or she'd keep finding it by what it used to say. */
    editSavedImage(
        id: number,
        fields: { description: string; useFor: string; embedding: Float32Array | undefined; embeddingModel: string | null },
    ): void {
        this.#run(
            "UPDATE savedImages SET description = ?, useFor = ?, embedding = ?, embeddingModel = ? WHERE id = ?",
            fields.description,
            fields.useFor,
            toBlob(fields.embedding),
            fields.embedding ? fields.embeddingModel : null,
            id,
        );
    }

    /** Undefined if it's been forgotten since she thought of it. */
    savedImageContent(id: number): { bytes: Uint8Array; mime: string; link: string | null } | undefined {
        return this.#all<{ bytes: Uint8Array; mime: string; link: string | null }>("SELECT bytes, mime, link FROM savedImages WHERE id = ?", id)[0];
    }

    /** How many of these accounts' pictures she has kept since then. */
    savedImagesSince(accounts: readonly string[], since: number): number {
        return accounts.reduce((total, account) => {
            const [row] = this.#all<{ total: number }>(
                "SELECT COUNT(*) AS total FROM savedImages WHERE userKey = ? AND savedAt >= ?",
                account,
                since,
            );
            return total + (row?.total ?? 0);
        }, 0);
    }

    noteImageSent(id: number, at: number): void {
        this.#run("UPDATE savedImages SET lastSentAt = ?, timesSent = timesSent + 1 WHERE id = ?", at, id);
    }

    deleteSavedImage(id: number): boolean {
        return this.#run("DELETE FROM savedImages WHERE id = ?", id).changes > 0;
    }

    /** Over the limit, what she has never used and likes least goes first. Returns how many went. */
    trimSavedImages(maxKept: number): number {
        const { changes } = this.#run(
            `DELETE FROM savedImages WHERE id IN (
                SELECT id FROM savedImages ORDER BY timesSent DESC, appeal DESC, savedAt DESC, id DESC LIMIT -1 OFFSET ?
            )`,
            maxKept,
        );
        return Number(changes);
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

/** Copied first, because a Float32Array needs an aligned buffer and SQLite's blob may not be. */
function toEmbedding(blob: Uint8Array | null): Float32Array | undefined {
    return blob ? new Float32Array(blob.slice().buffer) : undefined;
}

function toMemory(row: MemoryRow): Memory {
    return { ...row, embedding: toEmbedding(row.embedding) };
}

function toMemoryView(row: MemoryViewRow): MemoryView {
    return { ...row, indexed: row.indexed === 1 };
}

function toReactionsColumn(reactions: readonly MessageReaction[]): string | null {
    return reactions.length > 0 ? JSON.stringify(reactions) : null;
}

function toLoggedMessage(row: LoggedRow): LoggedMessage {
    const quote = row.replyTo ? (JSON.parse(row.replyTo) as QuotedMessage) : undefined;
    return {
        channel: row.channel,
        messageId: row.messageId,
        senderKey: row.userKey,
        senderName: row.displayName,
        isSelf: row.isSelf === 1,
        attended: row.attended === 1,
        digested: row.segmented === 1,
        text: row.text,
        sentAt: row.sentAt,
        quoted: quote ? { senderName: quote.by, text: quote.text } : undefined,
    };
}

function toChatMessage(row: LoggedRow): ChatMessage {
    const separator = row.channel.indexOf(":");
    const replyTo = row.replyTo ? (JSON.parse(row.replyTo) as QuotedMessage) : undefined;
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
        ...(replyTo ? { replyTo, replyToMessageId: replyTo.messageId } : {}),
        isSelf: row.isSelf === 1,
        isBacklog: false,
    };
}
