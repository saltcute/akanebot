import { z } from "zod";
import type { Clock } from "../lib/clock.ts";
import type { Usage } from "../llm/backend.ts";
import { createLinkReader } from "../llm/factories.ts";
import { linkReaderConfigSchema } from "../llm/links.ts";
import { LinkOpener } from "./open.ts";
import { httpSiteFetcher } from "./sites.ts";

export const linksConfigSchema = z
    .strictObject({
        /** Who fetches pages other than the known sites. `none` leaves her with only the known sites and platform previews. */
        reader: linkReaderConfigSchema,
        /** Read YouTube, X, Bilibili and GitHub from their own APIs, sending only the ID. */
        sites: z.boolean().default(true),
        /** Hosts she never opens, on top of the built-in document and file-sharing hosts. A host covers its subdomains. */
        blockedHosts: z.array(z.string().min(1)).default([]),
    })
    .prefault({});

export type LinksConfig = z.infer<typeof linksConfigSchema>;

/** `youtubeApiKey` comes from YOUTUBE_API_KEY. Without it a YouTube link gives only the title and channel. */
export function createLinkOpener(
    config: LinksConfig,
    options: { clock: Clock; onUsage: (usage: Usage, model: string) => void; youtubeApiKey?: string | undefined },
): LinkOpener {
    return new LinkOpener({
        clock: options.clock,
        sites: config.sites ? { fetcher: httpSiteFetcher, options: { youtubeApiKey: options.youtubeApiKey } } : undefined,
        reader: createLinkReader(config.reader, options.onUsage),
        blockedHosts: config.blockedHosts,
    });
}
