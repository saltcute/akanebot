import { readTraceEvents } from "../lib/trace-file.ts";
import { TRACE_DIRECTORY } from "../main-settings.ts";

const [messageId] = process.argv.slice(2);
if (!messageId) {
    console.log("Usage: pnpm explain <messageId>   (the id shown in the [gate ...] lines)");
    process.exit(1);
}

const events = readTraceEvents(TRACE_DIRECTORY).filter((event) => event.messageId === messageId);
if (events.length === 0) console.log(`No decisions recorded for message ${messageId}.`);
for (const event of events) console.log(JSON.stringify(event));
