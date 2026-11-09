import { loadConfig } from "../config.ts";
import { People } from "../control/people.ts";
import type { Memory } from "../memory/store.ts";
import { MemoryStore } from "../memory/store.ts";

const SIM_DATABASE = "data/sim-memory.db";
const USAGE = `Usage: pnpm memory [--sim] <command>
  list [scope]                  every memory, including archived ones
  search <text>                 memories whose text contains this
  show <id>                     one memory in full, with who it came from
  edit <id> gist|detail <text>  change a memory (its search index updates on the next nightly run)
  forget <id>                   delete one memory
  forget-user <platform:id>     delete everything derived from a person, on all their linked accounts
  restore <id>                  undo a merge or archive`;

const args = process.argv.slice(2);
const useSim = args[0] === "--sim";
if (useSim) args.shift();
const [command, first, second, ...rest] = args;

const { config } = loadConfig();
const store = new MemoryStore(useSim ? SIM_DATABASE : config.memory.path);

function describe(memory: Memory): string {
    const flags = [memory.kind, memory.status === "archived" ? "archived" : "", memory.supersededBy ? `replaced by ${memory.supersededBy}` : ""]
        .filter(Boolean)
        .join(", ");
    return `#${memory.id} [${flags}] imp=${memory.importance.toFixed(2)} conf=${memory.confidence.toFixed(2)} str=${memory.strength.toFixed(2)} ${memory.scope}\n    ${memory.gist}`;
}

function requireId(value: string | undefined): number {
    const id = Number(value);
    if (!Number.isInteger(id)) {
        console.error(USAGE);
        process.exit(1);
    }
    return id;
}

switch (command) {
    case "list":
        for (const memory of store.all()) if (!first || memory.scope === first) console.log(describe(memory));
        break;
    case "search":
        for (const memory of store.all()) if (first && `${memory.gist} ${memory.detail}`.includes(first)) console.log(describe(memory));
        break;
    case "show": {
        const id = requireId(first);
        const memory = store.get(id);
        if (!memory) {
            console.error(`No memory #${id}`);
            break;
        }
        console.log(describe(memory));
        console.log(`    detail: ${memory.detail || "(none)"}`);
        console.log(`    subject: ${memory.subject ?? "(none)"}, attributed to: ${memory.attributedTo ?? "(none)"}`);
        console.log(`    came from: ${store.sourceSpeakers(id).join(", ") || "(unknown)"}`);
        console.log(`    recalled ${memory.recallCount} times`);
        break;
    }
    case "edit": {
        const id = requireId(first);
        const text = rest.join(" ");
        if ((second !== "gist" && second !== "detail") || text === "") {
            console.error(USAGE);
            process.exit(1);
        }
        store.edit(id, { [second]: text });
        console.log(`Updated #${id}`);
        break;
    }
    case "forget":
        store.forget(requireId(first));
        console.log("Deleted.");
        break;
    case "forget-user":
        if (!first) {
            console.error(USAGE);
            process.exit(1);
        }
        console.log(`Deleted ${store.forgetUser(first, new People(config.people))} memories and their raw messages.`);
        break;
    case "restore": {
        const id = requireId(first);
        store.supersede(id, null);
        store.setStatus(id, "active");
        console.log(`Restored #${id}`);
        break;
    }
    default:
        console.log(USAGE);
}

store.close();
