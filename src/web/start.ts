import type { Runtime } from "../runtime.ts";
import { isLoopback, resolveWebToken, WebServer } from "./server.ts";

/** A console that fails to start must never take the bot down with it, so problems are reported and it carries on. */
export async function startWebConsole(
    settings: { enabled: boolean; host: string; port: number },
    runtime: Runtime,
    configuredToken: string | undefined,
    onError: (message: string) => void,
    configView?: () => unknown,
): Promise<WebServer | undefined> {
    if (!settings.enabled) return undefined;
    try {
        const { token, generated } = resolveWebToken(configuredToken || undefined);
        const server = new WebServer({ runtime, token, host: settings.host, port: settings.port, onError, configView });
        const url = await server.start();
        console.log(generated ? `Web UI: ${url}#token=${token}` : `Web UI: ${url} (sign in with AKANEBOT_WEB_TOKEN)`);
        if (!isLoopback(settings.host))
            console.log("Warning: the web UI is reachable from other machines and has no TLS, so the token can be intercepted.");
        return server;
    } catch (error) {
        onError(`Web UI didn't start: ${String(error)}`);
        return undefined;
    }
}
