// PlantUML code widget for SilverBullet — hand-written, no build step.
//
// This file *is* the plug: drop it in a space, run "Plugs: Reload", done. It
// implements the (tiny) plugos worker protocol itself instead of embedding
// SilverBullet's compiled worker runtime, which keeps it dependency-free and
// readable.
//
// Two consequences of not embedding that runtime:
//
//   * the global `fetch` here is the browser's own fetch — the runtime is what
//     patches it to route every request through the server's `/.proxy` endpoint
//     (which requires write access to the space);
//   * therefore diagrams are fetched straight from the browser by default, and
//     the server-side proxy is used explicitly, as `syscall("sandboxFetch.fetch")`,
//     only as a fallback.
//
// Protocol (see client/plugos/protocol.ts in SilverBullet):
//
//   client -> worker  {type: "inv",  id, name, args}
//   worker -> client  {type: "invr", id, result | error}
//   worker -> client  {type: "sys",  id, name, args}
//   client -> worker  {type: "sysr", id, result | error}
//   worker -> client  {type: "manifest", manifest}   (once, on load)
//
// Configuration (CONFIG page):
//
//   config.set("plantuml", {
//     serverurl = "https://www.plantuml.com/plantuml", -- what the browser fetches
//     proxyurl  = "http://10.0.0.5:8080",              -- optional fallback URL,
//                                                      -- defaults to serverurl
//     fetchmode = "auto",                              -- auto | frontend | proxy
//     darktheme = "cyborg",                            -- PlantUML theme for the
//                                                      -- dark variant, rendered
//                                                      -- on demand; false or
//                                                      -- "_none_" disables it
//     lighttheme = "_none_",                           -- optional light theme
//   })
//
// `fetchmode = "auto"` (the default) tries the frontend fetch first and falls
// back to the server proxy. A plain `http:` PlantUML server cannot be fetched
// from an `https:` space at all (mixed content), so such a target skips
// straight to the proxy. Use `www.plantuml.com`, not the apex `plantuml.com`:
// the apex redirects to `http://www.…` without CORS headers, which no browser
// fetch survives.

const PLUG_NAME = "plantuml";
const DEFAULT_SERVERURL = "https://www.plantuml.com/plantuml";

const manifest = {
  name: PLUG_NAME,
  requiredPermissions: ["shell", "fetch"],
  functions: {
    plantumlWidget: { codeWidget: "plantuml" },
    // Called by the widget itself, through `system.invokeFunction`, when the
    // editor switches to a theme whose diagram has not been rendered yet. A
    // function has to be declared here to be invokable that way.
    renderVariant: {},
  },
};

// ---------------------------------------------------------------------------
// Plugos worker protocol
// ---------------------------------------------------------------------------

const functions = {
  plantumlWidget: widget,
  renderVariant: renderVariant,
};

let syscallReqId = 0;
const pendingSyscalls = new Map();

function syscall(name, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++syscallReqId;
    pendingSyscalls.set(id, { resolve, reject });
    self.postMessage({ type: "sys", id, name, args });
  });
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "inv") {
    const fn = functions[message.name];
    if (!fn) {
      self.postMessage({
        type: "invr",
        id: message.id,
        error: `Function not loaded: ${message.name}`,
      });
      return;
    }
    Promise.resolve()
      .then(() => fn(...(message.args ?? [])))
      .then((result) =>
        self.postMessage({ type: "invr", id: message.id, result }),
      )
      .catch((error) =>
        self.postMessage({
          type: "invr",
          id: message.id,
          error: error?.message ?? String(error),
        }),
      );
  } else if (message?.type === "sysr") {
    const pending = pendingSyscalls.get(message.id);
    pendingSyscalls.delete(message.id);
    if (!pending) {
      return;
    }
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }
});

self.postMessage({ type: "manifest", manifest });

// ---------------------------------------------------------------------------
// PlantUML text encoding
// ---------------------------------------------------------------------------

// A diagram URL carries the source as a raw-deflate stream encoded with
// PlantUML's own base64 variant ("a transformation close to base64", per the
// PlantUML docs); the plantuml-encoder npm package does the same thing with
// pako, i.e. ~54 KB of bundled deflate. The browser can deflate by itself, so
// all that is needed here is the alphabet.
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

async function deflateRaw(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodePlantUml(text) {
  const deflated = await deflateRaw(new TextEncoder().encode(text));
  let encoded = "";
  for (let i = 0; i < deflated.length; i += 3) {
    const b1 = deflated[i];
    const b2 = deflated[i + 1] ?? 0;
    const b3 = deflated[i + 2] ?? 0;
    encoded += ALPHABET[b1 >> 2];
    encoded += ALPHABET[((b1 & 0x03) << 4) | (b2 >> 4)];
    encoded += ALPHABET[((b2 & 0x0f) << 2) | (b3 >> 6)];
    encoded += ALPHABET[b3 & 0x3f];
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// Fetching diagrams
// ---------------------------------------------------------------------------

function diagramUrl(serverurl, encoded) {
  return `${serverurl}${serverurl.endsWith("/") ? "" : "/"}svg/${encoded}`;
}

// Why a frontend fetch of `url` is impossible, or null when it may work.
function mixedContentReason(url) {
  if (location.protocol !== "https:") {
    return null;
  }
  let target;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "http:") {
    return null;
  }
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname)) {
    return null; // loopback is exempt from mixed-content blocking
  }
  return `an https page may not fetch ${url} (mixed content)`;
}

async function frontendFetch(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return await response.text();
}

// The server proxy answers with a base64 body, because the response crosses the
// worker boundary as JSON.
async function proxyFetch(url) {
  const { ok, status, base64Body } = await syscall("sandboxFetch.fetch", url);
  if (!ok || status >= 400) {
    throw new Error(`HTTP error! status: ${status}`);
  }
  const bytes = Uint8Array.from(atob(base64Body), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchDiagram(frontendUrl, proxyUrl, mode) {
  const blocked = mixedContentReason(frontendUrl);

  if (mode === "frontend") {
    if (blocked) {
      throw new Error(`frontend fetch mode requested, but ${blocked}`);
    }
    return await frontendFetch(frontendUrl);
  }
  if (mode === "proxy") {
    return await proxyFetch(proxyUrl);
  }

  if (blocked) {
    // Not worth attempting (and worth no warning): it is guaranteed to fail.
    console.info(`[${PLUG_NAME}] using the server proxy, because ${blocked}`);
    return await proxyFetch(proxyUrl);
  }

  try {
    return await frontendFetch(frontendUrl);
  } catch (error) {
    console.warn(
      `[${PLUG_NAME}] frontend fetch failed, retrying through the SilverBullet server proxy`,
      error,
    );
  }
  return await proxyFetch(proxyUrl);
}

async function pumlServer(config, uml) {
  const encoded = await encodePlantUml(uml);
  const frontendUrl = diagramUrl(config.serverurl, encoded);
  const proxyUrl = config.proxyurl
    ? diagramUrl(config.proxyurl, encoded)
    : frontendUrl;
  const mode = config.fetchmode ?? "auto";
  console.log(
    `[${PLUG_NAME}] requesting ${frontendUrl} (fetch mode: ${mode})` +
      (config.proxyurl ? ` (proxy fallback: ${proxyUrl})` : ""),
  );
  return await fetchDiagram(frontendUrl, proxyUrl, mode);
}

// Runs a user-provided script with the base64 of the diagram source as its only
// argument (see scripts/gen_plantuml_svg in the repository).
async function pumlLocal(generator, uml) {
  const bytes = new TextEncoder().encode(uml); // UTF-8, not btoa's Latin-1
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const { stdout, stderr } = await syscall("shell.run", generator, [
    btoa(binary),
  ]);
  if (stderr) {
    console.log(`[${PLUG_NAME}]`, stderr);
  }
  return stdout;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(text) {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// The code widget
// ---------------------------------------------------------------------------

// PlantUML has no automatic dark mode: the colors are baked into the render,
// and a dark diagram means asking for one of its own dark themes (`!theme
// cyborg`, `superhero`, `hacker`, `mars`, …). Without one, every diagram is a
// bright box on SilverBullet's dark theme. The widget therefore keeps one
// diagram per theme: it renders the variant the editor is showing, and asks for
// the other one — through `renderVariant` below — only once the theme actually
// switches to it.
const DEFAULT_DARK_THEME = "cyborg";

// Which configuration key holds the PlantUML theme of each variant.
const VARIANT_CONFIG = { light: "lighttheme", dark: "darktheme" };

// Renders are kept per (theme, server, source) for the lifetime of the plug
// worker, i.e. until the plug is reloaded: asking for the same variant again
// (a widget that scrolled back into view, a page reopened) costs nothing.
const renderCache = new Map();
const RENDER_CACHE_SIZE = 100;

// The variant for the editor's current theme is the one on screen. The other
// one may not have been rendered yet; `data-invert` then marks that what is on
// screen is not the variant for this theme (it is still being rendered, or
// there is no dark theme at all), so it is shown inverted rather than as a
// white box.
const WIDGET_CSS = `
html, body { background: transparent; }
.puml-variant { display: none; }
html:not([data-theme="dark"]) #plantuml .puml-variant[data-variant="light"],
html[data-theme="dark"] #plantuml .puml-variant[data-variant="dark"] { display: inline-block; }
#plantuml[data-invert] .puml-variant {
  display: inline-block;
  filter: invert(1) hue-rotate(180deg);
}
`;

// The theme reaches a widget iframe once, with the initial `html` message; and
// unlike panels, a widget is not sent a `theme` message when the editor
// switches between light and dark mode. The iframe is same-origin, so the
// widget watches the host document itself and renders the missing variant when
// the theme changes.
const WIDGET_SCRIPT = `
const hostRoot = (() => {
  try {
    return parent.document.documentElement;
  } catch {
    return null;
  }
})();
const pre = document.getElementById("plantuml");
const source = pre && pre.dataset.source;
const darkThemeAvailable = pre && pre.dataset.dark === "theme";
// Stored on the <pre>, so a re-mounted widget (whose html is replaced) starts
// from a clean slate rather than reusing a previous diagram's state.
const state = pre &&
  (pre.plantumlState || (pre.plantumlState = { pending: {}, failed: {} }));

const variantElement = (variant) =>
  pre && pre.querySelector('.puml-variant[data-variant="' + variant + '"]');

const wantedVariant = () => {
  const theme = (hostRoot && hostRoot.dataset.theme) ||
    document.documentElement.dataset.theme;
  return theme === "dark" ? "dark" : "light";
};

// Shows the variant for the editor's theme; while it does not exist yet, the
// one that does is shown inverted.
function show() {
  if (!pre || !state) {
    return;
  }
  const wanted = wantedVariant();
  if (variantElement(wanted)) {
    delete pre.dataset.invert;
    return;
  }
  pre.dataset.invert = "";
  if (wanted === "light" || darkThemeAvailable) {
    render(wanted);
  }
}

// Asks the plug for a variant that is not on screen yet.
async function render(variant) {
  if (
    !source || !pre || state.pending[variant] || state.failed[variant] ||
    typeof syscall !== "function"
  ) {
    return;
  }
  state.pending[variant] = true;
  try {
    const svg = await syscall(
      "system.invokeFunction",
      "plantuml.renderVariant",
      source,
      variant,
    );
    const span = document.createElement("span");
    span.className = "puml-variant";
    span.dataset.variant = variant;
    span.innerHTML = svg;
    delete pre.dataset.invert;
    pre.appendChild(span);
  } catch (error) {
    // Keep showing the inverted variant rather than retrying on every theme
    // change (or worse, on every re-render).
    state.failed[variant] = true;
    console.warn("[plantuml] could not render the " + variant + " diagram", error);
  } finally {
    delete state.pending[variant];
    show();
  }
}

const syncTheme = () => {
  const theme = hostRoot && hostRoot.dataset.theme;
  if (theme) {
    document.documentElement.dataset.theme = theme;
  }
  show();
};
syncTheme();
// Widget iframes are pooled and re-mounted, which evaluates this script again
// in the same window: the observer and the click hook are installed once, and
// the observer always calls the newest instance's syncTheme.
globalThis.plantumlSyncTheme = syncTheme;
if (!globalThis.plantumlThemeWatcher) {
  globalThis.plantumlThemeWatcher = true;
  if (hostRoot && typeof MutationObserver !== "undefined") {
    new MutationObserver(() => globalThis.plantumlSyncTheme()).observe(
      hostRoot,
      { attributes: true, attributeFilter: ["data-theme"] },
    );
  }
  // Clicking the widget should put the cursor back in the editor; "blur" is
  // the message the SilverBullet client acts on (the api() helper this used
  // to call does not exist in v2).
  document.addEventListener("click", () => {
    parent.postMessage({ type: "blur" }, "*");
  });
}
`;

// `!theme` goes right after `@startuml`, so a theme the diagram sets itself
// later in the source still wins: PlantUML applies the last `!theme`.
function themedSource(uml, theme) {
  if (!theme || theme === "_none_") {
    return uml;
  }
  const lines = uml.split("\n");
  const start = lines.findIndex((line) => /^\s*@start/i.test(line));
  if (start === -1) {
    return `!theme ${theme}\n${uml}`;
  }
  lines.splice(start + 1, 0, `!theme ${theme}`);
  return lines.join("\n");
}

async function loadConfig() {
  const config = await syscall("system.getConfig", PLUG_NAME, {
    serverurl: DEFAULT_SERVERURL,
  });
  if (config.darktheme === undefined) {
    config.darktheme = DEFAULT_DARK_THEME;
  }
  return config;
}

// Whether a variant is rendered with a PlantUML theme at all.
function usesTheme(config, variant) {
  const theme = config[VARIANT_CONFIG[variant]];
  return Boolean(theme) && theme !== "_none_";
}

async function renderDiagram(config, uml, theme) {
  // Keyed by what the render depends on, so a variant rendered earlier (a
  // re-mounted widget, a page opened again) is reused, and an in-flight request
  // is not made twice.
  const key = JSON.stringify([
    theme ?? null,
    config.serverurl ?? null,
    config.generator ?? null,
    uml,
  ]);
  const cached = renderCache.get(key);
  if (cached) {
    return await cached;
  }
  const pending = renderUncached(config, uml, theme);
  if (renderCache.size >= RENDER_CACHE_SIZE) {
    renderCache.delete(renderCache.keys().next().value);
  }
  renderCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    renderCache.delete(key);
    throw error;
  }
}

async function renderUncached(config, uml, theme) {
  const source = themedSource(uml, theme);
  if (config.serverurl) {
    return await pumlServer(config, source);
  }
  if (config.generator) {
    return await pumlLocal(config.generator, source);
  }
  throw new Error("configure either serverurl or generator");
}

// Whether the editor is in dark mode right now. `undefined` means the editor
// follows the operating system, in which case only the client knows which
// variant is needed — it asks for the other one right after mounting.
async function editorDarkMode() {
  try {
    return (await syscall("editor.getUiOption", "darkMode")) === true;
  } catch (error) {
    console.warn(`[${PLUG_NAME}] cannot read the editor's dark mode`, error);
    return false;
  }
}

function widgetHtml({ svg, variant, source, dark }) {
  return (
    `<style>${WIDGET_CSS}</style>` +
    `<pre id="plantuml" data-dark="${dark ? "theme" : "invert"}"` +
    (source ? ` data-source="${escapeAttribute(source)}"` : "") +
    `>` +
    `<span class="puml-variant" data-variant="${variant}">${svg}</span>` +
    `</pre>`
  );
}

function errorWidget(error) {
  return {
    html: widgetHtml({
      svg: escapeHtml(`PlantUML error: ${error?.message ?? error}`),
      variant: "light",
      source: "",
      dark: false,
    }),
    script: WIDGET_SCRIPT,
  };
}

// Called by the widget through `system.invokeFunction` when the editor switches
// to a variant that has not been rendered yet.
async function renderVariant(uml, variant) {
  const config = await loadConfig();
  return await renderDiagram(config, uml, config[VARIANT_CONFIG[variant]]);
}

async function widget(bodyText) {
  const config = await loadConfig();
  let dark = usesTheme(config, "dark");
  let variant = dark && (await editorDarkMode()) ? "dark" : "light";

  let svg;
  try {
    svg = await renderDiagram(config, bodyText, config[VARIANT_CONFIG[variant]]);
  } catch (error) {
    if (variant !== "dark") {
      console.error(`[${PLUG_NAME}] PUML generation failed`, error);
      return errorWidget(error);
    }
    // A dark theme that does not render should not cost the diagram itself:
    // fall back to the plain render and let dark mode invert it.
    console.warn(
      `[${PLUG_NAME}] dark render failed, falling back to the plain diagram`,
      error,
    );
    dark = false;
    variant = "light";
    try {
      svg = await renderDiagram(config, bodyText, config.lighttheme);
    } catch (fallbackError) {
      console.error(`[${PLUG_NAME}] PUML generation failed`, fallbackError);
      return errorWidget(fallbackError);
    }
  }

  return {
    html: widgetHtml({ svg, variant, source: bodyText, dark }),
    script: WIDGET_SCRIPT,
  };
}
