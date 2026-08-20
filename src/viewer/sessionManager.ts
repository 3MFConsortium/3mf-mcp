import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ModelStore } from "../inspection/store.js";

const DEFAULT_VIEWER_URL = "https://3mfviewer.com";
const SESSION_TTL_MS = 30 * 60 * 1000;
const RESULT_WAIT_MS = 15_000;
const VIEWER_STARTUP_WAIT_MS = 30_000;

export type ViewerMode = "url" | "system" | "headless";

interface BrowserDiagnostic {
  level: string;
  message: string;
  timestamp: string;
}

interface PendingCommand {
  id: string;
  command: string;
  arguments: Record<string, unknown>;
  createdAt: string;
  delivered: boolean;
}

interface CommandResult {
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message: string };
  completedAt: string;
}

interface ViewerSession {
  id: string;
  modelId: string;
  viewerUrl: string;
  fileName: string;
  createdAt: string;
  expiresAt: string;
  connectedAt: string | null;
  renderReady: boolean;
  lastError: string | null;
  commands: Map<string, PendingCommand>;
  results: Map<string, CommandResult>;
  captures: Map<string, Buffer>;
  initialCommands: Array<{ command: string; arguments: Record<string, unknown> }>;
  mode: ViewerMode;
  browser: Browser | null;
  page: Page | null;
  diagnostics: BrowserDiagnostic[];
  loadProgress: Record<string, unknown> | null;
  expiryTimer: NodeJS.Timeout;
}

export interface OpenViewerOptions {
  viewerUrl?: string;
  preset?: string;
  resourceId?: number;
  isolate?: boolean;
  wireframe?: boolean;
  edges?: boolean;
  mode?: ViewerMode;
  chromePath?: string;
  onProgress?: (progress: Record<string, unknown>) => void | Promise<void>;
}

const openSystemBrowser = async (url: string): Promise<{ launched: boolean; error?: string }> => {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return { launched: true };
  } catch (error) {
    return { launched: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};

const readBody = async (request: IncomingMessage, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body exceeds the viewer-session limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const safeJson = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export class ViewerSessionManager {
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private readonly sessions = new Map<string, ViewerSession>();

  constructor(private readonly store: ModelStore) {}

  async open(modelId: string, options: OpenViewerOptions = {}) {
    const model = this.store.get(modelId);
    const viewerUrl = new URL(
      options.viewerUrl?.trim() || process.env.MCP_VIEWER_URL?.trim() || DEFAULT_VIEWER_URL,
    );
    if (!['http:', 'https:'].includes(viewerUrl.protocol)) {
      throw new Error("viewer_url must use http or https.");
    }
    await this.ensureStarted();
    this.cleanup();
    const id = randomUUID();
    const now = Date.now();
    const initialCommands: ViewerSession["initialCommands"] = [];
    if (options.wireframe !== undefined || options.edges !== undefined) {
      initialCommands.push({
        command: "render.setOptions",
        arguments: {
          options: {
            ...(options.wireframe === undefined ? {} : { wireframe: options.wireframe }),
            ...(options.edges === undefined ? {} : { edges: options.edges }),
          },
        },
      });
    }
    if (options.resourceId !== undefined) {
      const target = { modelResourceId: options.resourceId };
      initialCommands.push({ command: "scene.select", arguments: { target } });
      if (options.isolate) initialCommands.push({ command: "scene.isolate", arguments: { target } });
    }
    initialCommands.push({
      command: "camera.setPreset",
      arguments: { preset: options.preset || "isometric" },
    });
    const expiryTimer = setTimeout(() => {
      const expired = this.sessions.get(id);
      if (expired) {
        this.disposeSession(expired);
        this.sessions.delete(id);
      }
    }, SESSION_TTL_MS);
    expiryTimer.unref();
    const session: ViewerSession = {
      id,
      modelId,
      viewerUrl: viewerUrl.origin,
      fileName: model.report.file.name,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      connectedAt: null,
      renderReady: false,
      lastError: null,
      commands: new Map(),
      results: new Map(),
      captures: new Map(),
      initialCommands,
      mode: options.mode ?? "url",
      browser: null,
      page: null,
      diagnostics: [],
      loadProgress: null,
      expiryTimer,
    };
    this.sessions.set(id, session);
    const view = this.view(session);
    try {
      if (session.mode === "system") {
        return { ...view, browser: await openSystemBrowser(view.url) };
      }
      if (session.mode === "headless") {
        await this.launchHeadless(session, options.chromePath, options.onProgress);
        return { ...this.view(session), browser: { launched: true, headless: true } };
      }
      return { ...view, browser: { launched: false, requested: false } };
    } catch (error) {
      this.disposeSession(session);
      this.sessions.delete(id);
      throw error;
    }
  }

  async command(
    sessionId: string,
    command: string,
    argumentsValue: Record<string, unknown>,
    waitMs = RESULT_WAIT_MS,
  ) {
    const session = this.requireSession(sessionId);
    const pending: PendingCommand = {
      id: randomUUID(),
      command,
      arguments: argumentsValue,
      createdAt: new Date().toISOString(),
      delivered: false,
    };
    session.commands.set(pending.id, pending);
    const deadline = Date.now() + Math.max(0, waitMs);
    while (Date.now() < deadline) {
      const result = session.results.get(pending.id);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { commandId: pending.id, pending: true, viewerConnected: !!session.connectedAt };
  }

  result(sessionId: string, commandId: string): CommandResult | { pending: true } {
    const session = this.requireSession(sessionId);
    return session.results.get(commandId) ?? { pending: true };
  }

  status(sessionId: string) {
    return this.view(this.requireSession(sessionId));
  }

  capture(sessionId: string, commandId: string): Buffer | undefined {
    return this.requireSession(sessionId).captures.get(commandId);
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.disposeSession(session);
    return this.sessions.delete(sessionId);
  }

  private view(session: ViewerSession) {
    return {
      viewerSessionId: session.id,
      modelId: session.modelId,
      url: `${this.baseUrl}/viewer/${session.id}/`,
      viewerUrl: session.viewerUrl,
      mode: session.mode,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      connected: !!session.connectedAt,
      renderReady: session.renderReady,
      lastError: session.lastError,
      browserDiagnostics: session.diagnostics.slice(-20),
      loadProgress: session.loadProgress,
    };
  }

  private requireSession(id: string): ViewerSession {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown or expired viewer session: ${id}`);
    this.store.get(session.modelId);
    return session;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) {
        this.disposeSession(session);
        this.sessions.delete(id);
      }
    }
  }

  private disposeSession(session: ViewerSession): void {
    clearTimeout(session.expiryTimer);
    if (session.browser) void session.browser.close().catch(() => undefined);
    session.browser = null;
    session.page = null;
  }

  private addDiagnostic(session: ViewerSession, level: string, message: string): void {
    session.diagnostics.push({ level, message, timestamp: new Date().toISOString() });
    if (session.diagnostics.length > 100) session.diagnostics.shift();
  }

  private resolveChromePath(configured?: string): string {
    const candidates = [
      configured?.trim(),
      process.env.MCP_CHROME_PATH?.trim(),
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter((value): value is string => Boolean(value));
    const executable = candidates.find(existsSync);
    if (!executable) {
      throw new Error(
        "Headless viewer mode requires Chrome or Chromium. Set MCP_CHROME_PATH to its executable.",
      );
    }
    return executable;
  }

  private async launchHeadless(
    session: ViewerSession,
    chromePath?: string,
    onProgress?: OpenViewerOptions["onProgress"],
  ): Promise<void> {
    const browser = await chromium.launch({
      executablePath: this.resolveChromePath(chromePath),
      headless: true,
      args: ["--disable-dev-shm-usage", "--enable-webgl", "--use-gl=angle"],
    });
    session.browser = browser;
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    session.page = page;
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        this.addDiagnostic(session, message.type(), message.text());
      }
    });
    page.on("pageerror", (error) => {
      session.lastError = error.message;
      this.addDiagnostic(session, "pageerror", error.message);
    });
    page.on("crash", () => {
      session.lastError = "The headless viewer page crashed.";
      this.addDiagnostic(session, "crash", session.lastError);
    });
    await page.goto(this.view(session).url, {
      waitUntil: "domcontentloaded",
      timeout: VIEWER_STARTUP_WAIT_MS,
    });
    let lastProgress = "";
    while (!session.renderReady) {
      if (session.lastError) throw new Error(`Headless viewer failed: ${session.lastError}`);
      if (page.isClosed()) throw new Error("Headless viewer closed before rendering the model.");
      if (session.loadProgress && onProgress) {
        const serialized = JSON.stringify(session.loadProgress);
        if (serialized !== lastProgress) {
          lastProgress = serialized;
          await onProgress(session.loadProgress);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.server && this.baseUrl) return;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    this.server.unref();
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Unable to start viewer broker.");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || "/", this.baseUrl || "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "public, max-age=86400" });
      response.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "viewer" || !parts[1]) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const session = this.requireSession(parts[1]);
    const action = parts[2] || "page";
    if (request.method === "GET" && action === "page") {
      this.sendPage(response, session);
      return;
    }
    if (request.method === "GET" && action === "model") {
      const model = this.store.get(session.modelId);
      response.writeHead(200, {
        "content-type": "model/3mf",
        "content-length": model.sourceBytes.byteLength,
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(session.fileName)}`,
        "cache-control": "no-store",
      });
      response.end(Buffer.from(model.sourceBytes));
      return;
    }
    if (request.method === "GET" && action === "commands") {
      const commands = [...session.commands.values()].filter((command) => !command.delivered);
      commands.forEach((command) => { command.delivered = true; });
      sendJson(response, 200, { commands });
      return;
    }
    if (request.method === "GET" && action === "status") {
      sendJson(response, 200, this.view(session));
      return;
    }
    if (request.method === "POST" && action === "status") {
      const body = JSON.parse((await readBody(request, 64 * 1024)).toString("utf8"));
      session.connectedAt = session.connectedAt || new Date().toISOString();
      if (body.renderReady === true) session.renderReady = true;
      if (typeof body.error === "string") session.lastError = body.error;
      if (body.progress && typeof body.progress === "object") session.loadProgress = body.progress;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && action === "results" && parts[3]) {
      const body = JSON.parse((await readBody(request, 1024 * 1024)).toString("utf8"));
      const result: CommandResult = {
        commandId: parts[3],
        ok: body.ok === true,
        ...(body.ok === true ? { result: body.result } : { error: body.error }),
        completedAt: new Date().toISOString(),
      };
      session.results.set(parts[3], result);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "PUT" && action === "captures" && parts[3]) {
      session.captures.set(parts[3], await readBody(request, 25 * 1024 * 1024));
      sendJson(response, 200, {
        url: `${this.baseUrl}/viewer/${session.id}/captures/${parts[3]}`,
      });
      return;
    }
    if (request.method === "GET" && action === "captures" && parts[3]) {
      const capture = session.captures.get(parts[3]);
      if (!capture) {
        sendJson(response, 404, { error: "Capture not found" });
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": capture.length,
        "cache-control": "no-store",
      });
      response.end(capture);
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  }

  private sendPage(response: ServerResponse, session: ViewerSession): void {
    const viewerOrigin = new URL(session.viewerUrl).origin;
    const embedScript = new URL("/embed.js", viewerOrigin).toString();
    const config = safeJson({
      sessionId: session.id,
      viewerUrl: viewerOrigin,
      fileName: session.fileName,
      initialCommands: session.initialCommands,
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="/viewer/${session.id}/"><title>${session.fileName}</title><style>html,body,#viewer{height:100%;margin:0}#status{position:fixed;z-index:5;left:12px;top:12px;padding:7px 11px;border-radius:8px;background:#111c;color:#fff;font:13px system-ui}</style></head><body><div id="status">Connecting to 3MF Viewer…</div><div id="viewer"></div><script src="${embedScript}"></script><script>
const config=${config}; const status=document.querySelector('#status');
const post=(path,value)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
const viewer=ThreeMFViewerEmbed.create({container:'#viewer',baseOrigin:config.viewerUrl,height:'100%',loadTimeoutMs:0,onError:(error)=>{const message=error.message||'Viewer error';status.textContent=message;void post('./status',{error:message});}});
async function execute(command,args,id){try{let result=await viewer.request(command,args||{});if(result&&result.blob instanceof Blob){const upload=await fetch('./captures/'+id,{method:'PUT',body:result.blob});const stored=await upload.json();result={...result,blob:undefined,captureUrl:stored.url};}await post('./results/'+id,{ok:true,result});}catch(error){await post('./results/'+id,{ok:false,error:{code:error.code||'command_failed',message:error.message||String(error)}});}}
async function poll(){try{const response=await fetch('./commands');const data=await response.json();for(const command of data.commands||[])await execute(command.command,command.arguments,command.id);}catch(error){status.textContent='Control connection interrupted';}setTimeout(poll,250);}
viewer.on('loadProgress',(progress)=>{status.textContent=progress.detail||progress.stage||'Loading '+config.fileName+'…';void post('./status',{progress});});
(async()=>{await viewer.ready();await post('./status',{connected:true});const rendered=new Promise((resolve)=>{const off=viewer.on('renderReady',(data)=>{off();resolve(data);});});const model=await fetch('./model');if(!model.ok)throw new Error('Model transfer failed: HTTP '+model.status);await viewer.sendFile(await model.blob(),{name:config.fileName});await rendered;for(const command of config.initialCommands)await viewer.request(command.command,command.arguments);status.textContent='Ready · '+config.fileName;setTimeout(()=>status.remove(),1800);await post('./status',{renderReady:true});poll();})().catch(error=>{const message=error.message||String(error);status.textContent=message;void post('./status',{error:message});});
</script></body></html>`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
      "content-security-policy": `default-src 'self'; script-src 'self' ${viewerOrigin} 'unsafe-inline'; frame-src ${viewerOrigin}; connect-src 'self' ${viewerOrigin}; style-src 'unsafe-inline'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(html);
  }
}
