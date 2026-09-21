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
 * - `"auto"` (default): try `"frontend"` first, fall back to `"proxy"`.
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

async function fetchDiagram(url: string, mode: FetchMode): Promise<string> {
  // `frontendFetch === fetch` means there is nothing to fall back to: either
  // the worker patch never happened, or it did and `nativeFetch` is missing.
  const proxyAvailable = mode !== "frontend" && frontendFetch !== fetch;

  if (mode !== "proxy") {
    try {
      return await requestDiagram(frontendFetch, url);
    } catch (error) {
      if (!proxyAvailable) {
        throw error;
      }
      console.warn(
        "silverbullet-plantuml: frontend fetch failed, retrying through the SilverBullet server proxy",
        error,
      );
    }
  }

  return await requestDiagram(fetch, url);
}

export async function pumlserver(
  serverurl: string,
  uml: string,
  mode: FetchMode = "auto",
) {
  try {
    const encoded = plantumlEncoder.encode(uml);
    let sep = "/";
    if (serverurl.endsWith("/"))
      sep = "";
    let url = serverurl + sep + 'svg/' + encoded;
    console.log("silverbullet-plantuml: requesting", url, `(fetch mode: ${mode})`);
    const data = await fetchDiagram(url, mode);
    return data;
  } catch (error) {
    console.error("PUML generation failed", error);
    return error;
  }
}

export async function widget(
  bodyText: string,
) {

  const userConfig = await system.getConfig("plantuml", { serverurl: 'https://plantuml.com/plantuml' });

  let result: string = bodyText;
  if ('serverurl' in userConfig) {
    result = await pumlserver(userConfig.serverurl, bodyText, userConfig.fetchmode);
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
