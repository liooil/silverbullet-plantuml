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
//     darktheme = false,                               -- optional PlantUML theme
//                                                      -- for dark mode; unset
//                                                      -- inverts the light one
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
  },
};

// ---------------------------------------------------------------------------
// Plugos worker protocol
// ---------------------------------------------------------------------------

const functions = {
  plantumlWidget: widget,
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

// ---------------------------------------------------------------------------
// The code widget
// ---------------------------------------------------------------------------

// PlantUML has no dark mode of its own: a diagram's colors — including its
// white background — are baked into the render, and the only way to get a dark
// diagram out of PlantUML is one of its own dark themes. Inverting the light
// render with a CSS filter instead needs no second render, and because
// PlantUML's default palette is nearly neutral it comes out looking neutral
// too. So that inversion is what dark mode does by default; `darktheme` below
// hands the dark variant to one of PlantUML's themes instead.
const WIDGET_CSS = `
html, body { background: transparent; }
.puml-variant { display: none; }
html:not([data-theme="dark"]) #plantuml .puml-variant[data-variant="light"],
html[data-theme="dark"] #plantuml .puml-variant[data-variant="dark"] { display: inline-block; }
html[data-theme="dark"] #plantuml[data-dark="invert"] .puml-variant[data-variant="light"] {
  display: inline-block;
  filter: invert(1) hue-rotate(180deg);
}
`;

// The theme reaches a widget iframe once, with the initial `html` message; and
// unlike panels, a widget is not sent a `theme` message when the editor
// switches between light and dark mode. The iframe is same-origin, so the
// widget watches the host document itself; the CSS above then picks the variant
// to show (or inverts it).
const WIDGET_SCRIPT = `
const hostRoot = (() => {
  try {
    return parent.document.documentElement;
  } catch {
    return null;
  }
})();
const syncTheme = () => {
  const theme = hostRoot && hostRoot.dataset.theme;
  if (theme) {
    document.documentElement.dataset.theme = theme;
  }
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
  // Clicking the widget should put the cursor back in the editor; "blur" is the
  // message the SilverBullet client acts on (the api() helper this used to call
  // does not exist in v2).
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

async function renderDiagram(config, uml, theme) {
  const source = themedSource(uml, theme);
  if (config.serverurl) {
    return await pumlServer(config, source);
  }
  if (config.generator) {
    return await pumlLocal(config.generator, source);
  }
  throw new Error("configure either serverurl or generator");
}

function widgetHtml(light, dark) {
  return (
    `<style>${WIDGET_CSS}</style>` +
    `<pre id="plantuml" data-dark="${dark === null ? "invert" : "theme"}">` +
    `<span class="puml-variant" data-variant="light">${light}</span>` +
    (dark === null
      ? ""
      : `<span class="puml-variant" data-variant="dark">${dark}</span>`) +
    `</pre>`
  );
}

async function widget(bodyText) {
  const config = await syscall("system.getConfig", PLUG_NAME, {
    serverurl: DEFAULT_SERVERURL,
  });

  let light;
  try {
    light = await renderDiagram(config, bodyText, config.lighttheme);
  } catch (error) {
    console.error(`[${PLUG_NAME}] PUML generation failed`, error);
    return {
      html: widgetHtml(
        escapeHtml(`PlantUML error: ${error?.message ?? error}`),
        null,
      ),
      script: WIDGET_SCRIPT,
    };
  }

  // Only a configured dark theme is rendered twice; without one dark mode just
  // inverts the light diagram, and a dark theme that fails to render falls back
  // to that as well.
  let dark = null;
  if (config.darktheme && config.darktheme !== "_none_") {
    try {
      dark = await renderDiagram(config, bodyText, config.darktheme);
    } catch (error) {
      console.warn(
        `[${PLUG_NAME}] dark theme render failed, inverting instead`,
        error,
      );
    }
  }

  return { html: widgetHtml(light, dark), script: WIDGET_SCRIPT };
}
