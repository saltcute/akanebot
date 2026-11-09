import { z } from "zod";
import { isTimeZone } from "../persona/schema.ts";

const personSchema = z.strictObject({
    /** What she knows them as, whatever their display name is today. */
    name: z.string().min(1),
    /** Every `platform:userId` this person uses. */
    ids: z.array(z.string().regex(/^[a-z]+:.+$/, "Expected platform:userId")).min(1),
    /** How she knows them, shown to her only while they are talking. Goes by account, so nobody can claim it with a nickname. */
    note: z.string().min(1).optional(),
    /** Other names people call them by. Two characters at least, since one would turn up inside unrelated words. */
    aliases: z.array(z.string().trim().min(2)).optional(),
    /** Their IANA zone, so their local time is worked out in code. Shown to her only while they are talking, like the note. */
    timezone: z.string().refine(isTimeZone, "Unknown time zone").optional(),
});

export type PersonEntry = z.infer<typeof personSchema>;

export const peopleSchema = z
    .array(personSchema)
    .superRefine((entries, context) => {
        const seen = new Set<string>();
        for (const id of entries.flatMap((entry) => entry.ids)) {
            if (seen.has(id)) context.addIssue({ code: "custom", message: `${id} is listed more than once, but an account can only be one person` });
            seen.add(id);
        }
        const aliasOwners = new Map<string, PersonEntry>();
        for (const entry of entries) {
            for (const alias of entry.aliases ?? []) {
                const owner = aliasOwners.get(alias.toLowerCase());
                if (owner && owner !== entry)
                    context.addIssue({ code: "custom", message: `${alias} is an alias of both ${owner.name} and ${entry.name}` });
                aliasOwners.set(alias.toLowerCase(), entry);
            }
        }
        for (const entry of entries) {
            const owner = aliasOwners.get(entry.name.toLowerCase());
            if (owner && owner !== entry) context.addIssue({ code: "custom", message: `${entry.name} is also an alias of ${owner.name}` });
        }
    })
    .default([]);

/**
 * Which accounts belong to the same person, as the operator declared it. An account nobody listed is simply its own person.
 * Links are looked up when needed and never written to the database, so editing the list needs no migration.
 */
export class People {
    #byAccount = new Map<string, PersonEntry>();

    constructor(entries: readonly PersonEntry[] = []) {
        for (const entry of entries) for (const id of entry.ids) this.#byAccount.set(id, entry);
    }

    entries(): readonly PersonEntry[] {
        return [...new Set(this.#byAccount.values())];
    }

    accountsOf(user: string): readonly string[] {
        return this.#byAccount.get(user)?.ids ?? [user];
    }

    /** The same value for all of someone's accounts. Only for comparing people, since it changes if the list is reordered. */
    personOf(user: string): string {
        return this.accountsOf(user)[0] ?? user;
    }

    nameOf(user: string): string | undefined {
        return this.#byAccount.get(user)?.name;
    }

    noteOf(user: string): string | undefined {
        return this.#byAccount.get(user)?.note;
    }

    timezoneOf(user: string): string | undefined {
        return this.#byAccount.get(user)?.timezone;
    }

    aliasesOf(user: string): readonly string[] {
        return this.#byAccount.get(user)?.aliases ?? [];
    }
}

export const NO_LINKS = new People();
