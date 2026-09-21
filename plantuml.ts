import { shell, system } from "@silverbulletmd/silverbullet/syscalls";
import plantumlEncoder from "plantuml-encoder";

/**
 * How a diagram request reaches the PlantUML server:
 *
 * - `"frontend"`: the browser's own `fetch`, straight from the client to the
 *   PlantUML server. Needs the server to send CORS headers (plantuml.com and
 *   kroki.io do), but no server-side proxy, hence no write access and no
 *   online SilverBullet server.
 * - `"proxy"`: SilverBullet's `/.proxy` endpoint, i.e. the request is made by
 *   the SilverBullet server. Works for servers without CORS headers, but
 *   requires write access to the space and a reachable server.
 * - `"auto"` (default): try `"frontend"` first, fall back to `"proxy"`. A
 *   frontend fetch that a browser is guaranteed to refuse (plain `http:` from
 *   an `https:` page) is skipped and goes straight to the proxy.
 */
export type FetchMode = "frontend" | "proxy" | "auto";

/**
 * The browser's own `fetch`.
 *
 * Plug code runs in a web worker in which SilverBullet replaces `fetch` with a
 * version that routes every request through the server's `/.proxy` endpoint.
 * The unpatched browser implementation is kept around as `nativeFetch`. When
 * this plug runs somewhere that patch is absent (an older SilverBullet, or a
 * test harness) both names refer to the same function.
 */
const frontendFetch: typeof fetch =
  (globalThis as { nativeFetch?: typeof fetch }).nativeFetch ?? fetch;

export async function pumllocal(generator: string, uml: string) {
  try {
    const buml = btoa(uml);
    const { stdout, stderr } = await shell.run(generator, [buml]);
    console.log(stderr);
    return stdout;
  } catch (error) {
    console.error("PUML generation failed", error);
    return error;
  }
}

async function requestDiagram(
  doFetch: typeof fetch,
  url: string,
): Promise<string> {
  const response = await doFetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return await response.text();
}

/**
 * Why a frontend fetch of `url` is impossible, or `null` when it may work.
 *
 * A browser refuses to fetch plain `http:` from a page served over `https:`
 * (mixed content), so on an https space an `http://` PlantUML server can only
 * be reached through the server proxy. Loopback is exempt: browsers treat it as
 * potentially trustworthy.
 */
function mixedContentReason(url: string): string | null {
  if (location.protocol !== "https:") {
    return null;
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "http:") {
    return null;
  }
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname)) {
    return null;
  }
  return `an https page may not fetch ${url} (mixed content)`;
}

async function fetchDiagram(
  frontendUrl: string,
  proxyUrl: string,
  mode: FetchMode,
): Promise<string> {
  const blocked = mixedContentReason(frontendUrl);

  // `frontendFetch === fetch` means there is nothing to choose between: either
  // the worker patch never happened, or it did and `nativeFetch` is missing.
  const frontendAvailable = frontendFetch !== fetch;

  if (mode === "frontend") {
    if (blocked) {
      throw new Error(`frontend fetch mode requested, but ${blocked}`);
    }
    if (!frontendAvailable) {
      throw new Error("frontend fetch mode requested, but no browser fetch is available");
    }
    return await requestDiagram(frontendFetch, frontendUrl);
  }
  if (mode === "proxy" || !frontendAvailable) {
    return await requestDiagram(fetch, proxyUrl);
  }

  if (blocked) {
    // Not worth attempting (and worth no warning): it is guaranteed to fail.
    console.info(
      `silverbullet-plantuml: using the server proxy, because ${blocked}`,
    );
    return await requestDiagram(fetch, proxyUrl);
  }

  try {
    return await requestDiagram(frontendFetch, frontendUrl);
  } catch (error) {
    console.warn(
      "silverbullet-plantuml: frontend fetch failed, retrying through the SilverBullet server proxy",
      error,
    );
  }
  return await requestDiagram(fetch, proxyUrl);
}

function diagramUrl(serverurl: string, encoded: string): string {
  const sep = serverurl.endsWith("/") ? "" : "/";
  return `${serverurl}${sep}svg/${encoded}`;
}

/**
 * @param serverurl base URL used for the frontend fetch
 * @param proxyurl base URL used for the proxy fallback, `serverurl` when unset
 */
export async function pumlserver(
  serverurl: string,
  uml: string,
  mode: FetchMode = "auto",
  proxyurl?: string,
) {
  try {
    const encoded = plantumlEncoder.encode(uml);
    const frontendUrl = diagramUrl(serverurl, encoded);
    const proxyUrl = proxyurl ? diagramUrl(proxyurl, encoded) : frontendUrl;
    console.log(
      "silverbullet-plantuml: requesting",
      frontendUrl,
      `(fetch mode: ${mode})`,
      proxyurl ? `(proxy fallback: ${proxyurl})` : "",
    );
    return await fetchDiagram(frontendUrl, proxyUrl, mode);
  } catch (error) {
    console.error("PUML generation failed", error);
    return error;
  }
}

export async function widget(
  bodyText: string,
) {

  // `www.` matters: the apex domain answers with a 301 to `http://www.…` that
  // carries no CORS headers, so a browser fetch of `https://plantuml.com/…`
  // always fails (the server proxy follows the redirect just fine).
  const userConfig = await system.getConfig("plantuml", { serverurl: 'https://www.plantuml.com/plantuml' });

  let result: string = bodyText;
  if ('serverurl' in userConfig) {
    result = await pumlserver(
      userConfig.serverurl,
      bodyText,
      userConfig.fetchmode,
      userConfig.proxyurl,
    );
  } else if ('generator' in userConfig) {
    result = await pumllocal(userConfig.generator, bodyText);
  } else {
    console.error("silverbullet-plantuml: Configure either serverurl or generator");
  }
  return {
    html: `<pre id="plantuml">${result}</pre>`,
    script: `
    document.addEventListener("click", () => {
      api({type: "blur"});
    });
    `,
  };
}
