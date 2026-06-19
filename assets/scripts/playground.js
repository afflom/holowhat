import Alpine from "./alpine-fork.js"
import {
  Automerge,
  Repo,
  initializeWasm,
} from "https://esm.sh/@automerge/automerge-repo@2.5.1/slim?bundle-deps"

import AlpineBlock from "./alpine-block.js"
import Observer from "./observer.js"
import automergeSyncPlugin from "./automerge-sync-plugin.js"

// Import Holospaces Browser Peer Substrate
import init, { Console, WebRtcLink } from "../../pkg/holospaces_web.js";

// Loader animation
document.body.innerHTML += `
  <div id="page-loader" style="
    position:fixed;
    inset:0;
    background:#0b0f19;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    z-index:999999;
    opacity:1;
    transition: opacity 300ms ease;
    color: #4f46e5;
    font-family: system-ui, sans-serif;
  ">
    <div class="loader-spinner" style="
      border: 4px solid rgba(79, 70, 229, 0.1);
      border-left-color: #4f46e5;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
    "></div>
    <div style="margin-top: 16px; font-weight: 500; font-size: 14px; letter-spacing: 0.05em; text-transform: uppercase;">Booting Holospaces Substrate...</div>
  </div>
  <style>
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
`

// 1. Initialize Automerge WASM
await initializeWasm(
  fetch("https://esm.sh/@automerge/automerge@3.2.1/dist/automerge.wasm"),
)

// 2. Initialize Holospaces Substrate
await init();
const console0 = new Console();
const opId = console0.sign_in(new TextEncoder().encode("playground-operator"));
console.log("Holospaces Substrate Peer online. Signed in as operator:", opId);

window.lock = false
window.Automerge = Automerge
window.Alpine = Alpine
window.automergeSyncPlugin = automergeSyncPlugin
window.console0 = console0;

// Global WebRTC Sync Link
let cnLink = null;
window.cnLink = cnLink;

// 3. Custom Holospaces Storage Adapter for Automerge Repo
class HolospacesStorageAdapter {
  async load(keyArray) {
    const key = keyArray.join("/")
    console.log("HolospacesStorageAdapter: load called with keyArray =", keyArray, "key =", key);
    let kappa = localStorage.getItem("hs-doc-kappa:" + key)
    if (!kappa && keyArray[0] === "document") {
      kappa = localStorage.getItem("hs-doc-kappa:" + keyArray[1])
    }
    if (!kappa) {
      // Check if we have pre-cached/mocked data for this document ID
      let localData = localStorage.getItem("hs-doc-data:" + key);
      if (!localData && keyArray[0] === "document") {
        localData = localStorage.getItem("hs-doc-data:" + keyArray[1]);
      }
      if (localData) {
        console.log("HolospacesStorageAdapter: load found pre-cached data for key =", key);
        return new Uint8Array(JSON.parse(localData));
      }
      console.log("HolospacesStorageAdapter: load returned undefined for key =", key);
      return undefined;
    }
    const bytes = console0.resolve(kappa);
    if (!bytes) {
      console.log("HolospacesStorageAdapter: load could not resolve kappa =", kappa);
      return undefined;
    }
    console.log("HolospacesStorageAdapter: load successfully resolved bytes for kappa =", kappa);
    return new Uint8Array(bytes);
  }

  async save(keyArray, binary) {
    const key = keyArray.join("/")
    console.log("HolospacesStorageAdapter: save called with keyArray =", keyArray, "key =", key, "length =", binary.length);
    const array = Array.from(binary);
    // Put bytes in the content-addressed store
    const kappa = console0.cn_put(binary);
    localStorage.setItem("hs-doc-kappa:" + key, kappa);
    localStorage.setItem("hs-doc-data:" + key, JSON.stringify(array));
    
    // Announce new document version
    if (cnLink && cnLink.is_open()) {
      try {
        console0.cn_announce(kappa);
        console0.cn_pump(cnLink);
      } catch (e) {
        console.error("Failed to announce document update:", e);
      }
    }
  }

  async remove(keyArray) {
    const key = keyArray.join("/")
    console.log("HolospacesStorageAdapter: remove called with keyArray =", keyArray, "key =", key);
    localStorage.removeItem("hs-doc-kappa:" + key)
    localStorage.removeItem("hs-doc-data:" + key)
  }

  async loadRange(keyPrefixArray) {
    const prefix = keyPrefixArray.join("/")
    console.log("HolospacesStorageAdapter: loadRange called with keyPrefixArray =", keyPrefixArray, "prefix =", prefix);
    const results = []
    for (let i = 0; i < localStorage.length; i++) {
      const localKey = localStorage.key(i)
      if (localKey && localKey.startsWith("hs-doc-data:")) {
        const keyStr = localKey.replace("hs-doc-data:", "")
        if (keyStr.startsWith(prefix)) {
          const keyArray = keyStr.split("/")
          const dataJson = localStorage.getItem(localKey)
          if (dataJson) {
            const binary = new Uint8Array(JSON.parse(dataJson))
            console.log("HolospacesStorageAdapter: loadRange matched keyStr =", keyStr, "with prefix =", prefix);
            results.push({ key: keyArray, data: binary })
          }
        }
      }
    }
    console.log("HolospacesStorageAdapter: loadRange returning results =", results);
    return results
  }
}

// 4. Initialize Automerge Repository using Holospaces Storage
const repo = new Repo({
  storage: new HolospacesStorageAdapter(),
  network: [], // Zero central servers - Sync is handled purely peer-to-peer via Holospaces WebRTC Link
})

window.repo = repo
window.handle = null

// 5. Global Mock API to handle Worlds and Session requests in-browser
const originalFetch = window.fetch;
window.fetch = async function (url, options) {
  const cleanUrl = url.startsWith("/") ? url : "/" + url;
  if (cleanUrl.startsWith("blocks/")) {
    if (cleanUrl === "blocks/@playground") {
      const blocks = [
        "about-page", "api-client", "block-editor", "code", "cursor", "data",
        "device", "devices", "files", "home-page", "library", "login", "menu",
        "minimap", "navbar", "pointer", "profile", "spotlight",
        "spotlight-button", "user", "window", "world", "worlds"
      ].map(name => ({ name }));
      return new Response(JSON.stringify(blocks), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const relativePath = url.startsWith("/") ? url.substring(1) : url;
    return originalFetch(relativePath, options);
  }

  if (url.startsWith("/api/auth/set-session")) {
    localStorage.setItem("playground_logged_in", "true");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  
  if (url.startsWith("/api/worlds")) {
    if (options && options.method === "POST") {
      const body = JSON.parse(options.body);
      let list = JSON.parse(localStorage.getItem("hs-worlds-list") || "[]");
      if (!list.some(w => w.automerge_id === body.id)) {
        list.push({ automerge_id: body.id, slug: body.id });
        localStorage.setItem("hs-worlds-list", JSON.stringify(list));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    } else if (options && options.method === "PATCH") {
      const body = JSON.parse(options.body);
      const parts = url.split("/");
      const id = parts[parts.length - 1];
      let list = JSON.parse(localStorage.getItem("hs-worlds-list") || "[]");
      const index = list.findIndex(w => w.automerge_id === id);
      if (index !== -1) {
        list[index].slug = body.slug;
        localStorage.setItem("hs-worlds-list", JSON.stringify(list));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    } else {
      let list = JSON.parse(localStorage.getItem("hs-worlds-list") || "[]");
      if (list.length === 0) {
        // Bootstrap a default world if none exists
        const defaultId = localStorage.getItem("hs-world:default");
        if (defaultId) {
          list.push({ automerge_id: defaultId, slug: "default" });
          localStorage.setItem("hs-worlds-list", JSON.stringify(list));
        }
      }
      return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
  
  return originalFetch.apply(this, arguments);
};

// 6. Bootstrap Default Package ("3JmVZBuZJrg6HK6kr9m9KRuZebxA") and Default World on First Run
async function bootstrapPresets() {
  const defaultPkgId = "3JmVZBuZJrg6HK6kr9m9KRuZebxA";
  const defaultWorldId = "2RsvqRvmUqCmxPhEbdXtwW4qsdFm";
  
  // Bootstrap Default Packages Document (containing standard Alpine Blocks)
  let pkgExists = localStorage.getItem("hs-doc-kappa:document/" + defaultPkgId) ||
                  localStorage.getItem("hs-doc-data:document/" + defaultPkgId) ||
                  localStorage.getItem("hs-doc-kappa:" + defaultPkgId) ||
                  localStorage.getItem("hs-doc-data:" + defaultPkgId) ||
                  localStorage.getItem("hs-doc-data:" + defaultPkgId + "/snapshot/bootstrap");
  if (!pkgExists) {
    const pkgHandle = repo.create();
    pkgHandle.change(doc => {
      doc.name = "playground";
      doc.packages = [];
    });
    
    const blocks = [
      "about-page-block.html", "api-client-block.html", "block-editor-block.html",
      "block-mixin.html", "code-block.html", "code-peers-mixin.html",
      "code-scroll-mixin.html", "coordinates-mixin.html", "cursor-block.html",
      "data-block.html", "dblclick-mixin.html", "device-block.html",
      "devices-block.html", "doc-mixin.html", "draggable-mixin.html",
      "files-block.html", "home-page-block.html", "library-block.html",
      "login-block.html", "menu-block.html", "menu-mixin.html",
      "minimap-block.html", "navbar-block.html", "pointer-block.html",
      "profile-block.html", "spotlight-block.html", "spotlight-button-block.html",
      "user-block.html", "window-block.html", "world-block.html",
      "world-cell-mixin.html", "world-scroll-mixin.html", "world-sync-mixin.html",
      "world-theme-mixin.html", "world-upload-mixin.html", "worlds-block.html",
      "shell-block.html", "messenger-block.html"
    ];
    
    for (const block of blocks) {
      const name = block.replace(".html", "");
      try {
        const resp = await originalFetch("blocks/" + block);
        if (resp.ok) {
          const text = await resp.text();
          pkgHandle.change(doc => {
            doc[name] = text;
          });
        }
      } catch (e) {
        console.error("Failed to bootstrap block:", block, e);
      }
    }
    
    // Map defaultPkgId to this document's local data (both formats)
    const docData = Array.from(Automerge.save(pkgHandle.doc()));
    localStorage.setItem("hs-doc-data:document/" + defaultPkgId, JSON.stringify(docData));
    localStorage.setItem("hs-doc-data:" + defaultPkgId + "/snapshot/bootstrap", JSON.stringify(docData));
    localStorage.setItem("hs-pkg:playground", pkgHandle.documentId);
    console.log("Bootstrapped playground blocks package:", pkgHandle.documentId);
  }
  
  // Bootstrap Default World Document
  let worldExists = localStorage.getItem("hs-doc-kappa:document/" + defaultWorldId) ||
                    localStorage.getItem("hs-doc-data:document/" + defaultWorldId) ||
                    localStorage.getItem("hs-doc-kappa:" + defaultWorldId) ||
                    localStorage.getItem("hs-doc-data:" + defaultWorldId) ||
                    localStorage.getItem("hs-doc-data:" + defaultWorldId + "/snapshot/bootstrap");
  if (!worldExists) {
    const worldHandle = repo.create();
    worldHandle.change(doc => {
      doc.name = "Welcome World";
      doc.packages = [defaultPkgId];
      doc.theme = "night";
      doc.font = "Nanum Pen Script";
      doc.world = [
        {
          id: "home-block",
          tagName: "home-page-block",
          props: {
            x: "350",
            y: "100"
          }
        }
      ];
    });
    
    // Map defaultWorldId to this document's local data (both formats)
    const docData = Array.from(Automerge.save(worldHandle.doc()));
    localStorage.setItem("hs-doc-data:document/" + defaultWorldId, JSON.stringify(docData));
    localStorage.setItem("hs-doc-data:" + defaultWorldId + "/snapshot/bootstrap", JSON.stringify(docData));
    localStorage.setItem("hs-world:default", worldHandle.documentId);
    console.log("Bootstrapped welcome world document:", worldHandle.documentId);
  }
}

await bootstrapPresets();

// Determine Document ID to load
let docUrl = new URLSearchParams(location.search).get("id") || window.AUTOMERGE_ID || location.pathname.split("/").pop();
if (docUrl === "2RsvqRvmUqCmxPhEbdXtwW4qsdFm" || !docUrl || docUrl === "2RsvqRvmUqCmxPhEbdXtwW4qsdFm" || docUrl === "worlds" || docUrl === "login.html" || docUrl === "worlds.html") {
  const localDefault = localStorage.getItem("hs-world:default");
  docUrl = localDefault || "2RsvqRvmUqCmxPhEbdXtwW4qsdFm";
}

async function findWithBackoff(id, maxRetries = 3, delay = 300) {
  let attempt = 0
  while (attempt <= maxRetries) {
    try {
      return await repo.find(id)
    } catch (e) {
      console.log("Find error:", e)
      await new Promise((res) => setTimeout(res, delay * Math.pow(2, attempt)))
    }
    attempt++
  }
  throw new Error(`Failed to find document with id: ${id}`)
}

handle = await findWithBackoff(docUrl)
handle.change(doc => {
  if (!doc.world) {
    doc.world = [];
  }
});
window.handle = handle

window.throttledQueue = []
window.throttledTimer = null

window.throttledTick = function () {
  window.throttledTimer = null
  if (!window.throttledQueue.length) return
  const batch = window.throttledQueue
  window.throttledQueue = []
  try {
    handle.change((doc) => {
      for (const fn of batch) {
        try {
          fn(doc)
        } catch (e) {
          console.error("throttledChange fn error:", e)
        }
      }
    })
  } finally {
    if (window.throttledQueue.length)
      window.throttledTimer = setTimeout(window.throttledTick, 1000)
  }
}

window.throttledChange = (fn) => {
  window.throttledQueue.push(fn)
  if (window.throttledTimer === null)
    window.throttledTimer = setTimeout(window.throttledTick, 1000)
}

function createObserved(doc) {
  return new Observer(
    structuredClone(doc),
    (evt) => {
      if (window.lock === true) {
        window.lock = false
        return
      }

      window.lock = true
      handle.change((doc) => {
        const { action, object, name, oldValue } = evt || {}
        const keyPath = (evt.keyPath || evt.keypath || "").split(".").slice(1) // drop OBSERVED-*
        if (!keyPath.length) return

        console.log("Change observed key path:", keyPath.join("."))
        setByPath(doc, keyPath, object[name])
      })
      window.lock = false
    },
    { ignoreSameValueReassign: true },
  )
}

handle.on("change", (evt) => {
  if (!window.lock) {
    Alpine.$data(document.body).doc = createObserved(evt.doc)
  }
})

Alpine.magic("id", (el) => {
  let host = el.getRootNode().host
  while (host && !host.id) {
    host = host.getRootNode().host
  }
  return host ? host.id : null
})

Alpine.magic("world", (el) => {
  return Alpine.$data(
    document.querySelector("world-block").shadowRoot.querySelector("div"),
  )
})

Alpine.magic("props", (el) => {
  const host = el.getRootNode().host
  return host.props
})

Alpine.magic("host", (el) => {
  return el.getRootNode().host
})

Alpine.magic("broadcast", () => (type, data) => {
  if (cnLink && cnLink.is_open()) {
    // Announce current state's kappa
    try {
      const kappa = localStorage.getItem("hs-doc-kappa:" + docUrl);
      if (kappa) {
        console0.cn_announce(kappa);
        console0.cn_pump(cnLink);
      }
    } catch (e) {
      console.error("WebRTC sync broadcast failed:", e);
    }
  }
})

function setByPath(obj, path, value) {
  let current = obj
  const lastKey = path.at(-1)

  for (let key of path.slice(0, -1)) {
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {}
    }

    current = current[key]
  }

  current[lastKey] = value
}

Alpine.data("playground", () => {
  return {
    doc: createObserved(handle.doc()),
    init() {
      // Periodic content network pump (symmetric peer transmission over WebRTC data channel)
      setInterval(() => {
        if (cnLink && cnLink.is_open()) {
          console0.cn_pump(cnLink);
        }
      }, 50);
      
      // Periodic content discovery: check if remote peer has announced new states
      setInterval(async () => {
        if (cnLink && cnLink.is_open()) {
          const knownKappasJson = console0.cn_discover();
          if (knownKappasJson) {
            const knownKappas = JSON.parse(knownKappasJson);
            for (const kappa of knownKappas) {
              const localHas = console0.resolve(kappa);
              if (!localHas) {
                console0.cn_fetch_start(kappa);
                let resolvedBytes = null;
                for (let i = 0; i < 20; i++) {
                  console0.cn_pump(cnLink);
                  const r = console0.cn_fetch_poll();
                  if (r !== undefined) {
                    resolvedBytes = r;
                    break;
                  }
                  await new Promise(res => setTimeout(res, 50));
                }
                if (resolvedBytes) {
                  // Merge loaded bytes into the current document
                  const remoteDoc = Automerge.load(new Uint8Array(resolvedBytes));
                  handle.change(doc => {
                    Automerge.merge(doc, remoteDoc);
                  });
                  console.log("Synced remote changes successfully!");
                }
              }
            }
          }
        }
      }, 3000);
    },
  }
})

Alpine.start()

function defineBlock(pkg, tagName, template) {
  if (!customElements.get(tagName)) {
    class AlpineBlockSFC extends AlpineBlock {}
    AlpineBlockSFC.pkg = pkg
    AlpineBlockSFC.tagName = tagName
    AlpineBlockSFC.template = template
    customElements.define(tagName, AlpineBlockSFC)
  } else {
    customElements.get(tagName).template = template
  }
}

const pkgs = Array.from(
  new Set(["3JmVZBuZJrg6HK6kr9m9KRuZebxA", ...(handle.doc()?.packages || [])]),
)

const blockTemplates = []

for (let pkg of pkgs) {
  let pkgHandle = await findWithBackoff(pkg)
  const pkgDoc = pkgHandle.doc()

  const files = Object.entries(pkgDoc)

  for (let [name, source] of files) {
    if (name === "name" || name === "packages") continue;
    const template = document.createElement("template")
    template.id = `${pkgDoc.name}-${name}`
    template.innerHTML = source
    document.body.appendChild(template)

    if (name.split("-").pop() === "block" || name.split("-").pop() === "cell") {
      blockTemplates.push({
        pkg: pkgDoc.name,
        name: name,
        template,
      })
    }
  }
}

for (let block of blockTemplates) {
  defineBlock(block.pkg, block.name, block.template)
}

// Support for creating WebRTC Content Sync Connection inside the app UI
window.connectPeerLink = async (isInitiator, targetSdp) => {
  cnLink = new WebRtcLink(isInitiator);
  window.cnLink = cnLink;
  if (isInitiator) {
    const sdp = await cnLink.create_offer();
    return sdp;
  } else {
    const answer = await cnLink.accept_offer(targetSdp);
    return answer;
  }
};

window.acceptPeerAnswer = async (answerSdp) => {
  if (cnLink) {
    await cnLink.accept_answer(answerSdp);
  }
};

window.exchangeIce = async (iceLines) => {
  if (cnLink) {
    for (const line of iceLines.split("\n")) {
      const candidate = line.trim();
      if (candidate) {
        try {
          await cnLink.add_ice(candidate);
        } catch(e) {
          console.error(e);
        }
      }
    }
  }
};

// Remove page loader
const loader = document.getElementById("page-loader")
if (loader) {
  loader.style.opacity = "0"
  setTimeout(() => loader.remove(), 300)
}
