import Alpine from "./alpine-fork.js";
import { Participant, Event, Collection, App, AppIndex, Shell, canonicalJson, sha256, HoloAppsCrypto, base64Encode, base64Decode, encryptPayload, decryptPayload } from "./holo-apps.js";
import { messengerReducer, createMessengerApp } from "./holo-messenger.js";
import init, { Console, WebRtcLink } from "../../../pkg/holospaces_web.js";

// Initialize globals for custom SFC blocks (e.g. messenger-block)
window.Alpine = Alpine;
window.handle = {
  doc: () => ({ world: [] }),
  change: () => {},
  on: () => {}
};

// Initialize Substrate WebAssembly
await init();
const console0 = new Console();
console.log("Substrate console active in Holo-Apps Shell");

// WebRTC Signaling and sync state
let cnLink = null;
window.cnLink = cnLink;
const processedKappas = new Set();

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

// Periodic content network pump
let linkWasOpen = false;
setInterval(() => {
  if (window.cnLink && window.cnLink.is_open()) {
    console0.cn_pump(window.cnLink);
    if (!linkWasOpen) {
      linkWasOpen = true;
      console.log("WebRTC Link opened! Announcing all local workspace events...");
      announceAllWorkspaceEvents();
    }
  } else {
    linkWasOpen = false;
  }
}, 50);

function announceAllWorkspaceEvents() {
  const shell = window.shellInstance;
  if (!shell) return;

  if (shell.participant) {
    try {
      const ann = {
        type: "HoloIdAnnouncement",
        id: shell.participant.id,
        name: localStorage.getItem("holoapps_nickname") || "Operator",
        curveId: shell.participant.curveId
      };
      const annJson = JSON.stringify(ann);
      const bytes = new TextEncoder().encode(annJson);
      const kappa = console0.cn_put(bytes);
      console0.cn_announce(kappa);
      console.log("Announced Holo ID to the local swarm:", ann);
    } catch (e) {
      console.error("Failed to announce Holo ID:", e);
    }
  }

  const toAnnounce = [];
  
  if (shell.configCollection) {
    for (const ev of shell.configCollection.events.values()) {
      toAnnounce.push(ev);
    }
  }
  
  if (shell.activeWorkspace) {
    for (const ev of shell.activeWorkspace.collection.events.values()) {
      toAnnounce.push(ev);
    }
    for (const ch of shell.activeWorkspace.channels) {
      if (ch.collection) {
        for (const ev of ch.collection.events.values()) {
          toAnnounce.push(ev);
        }
      } else {
        const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${ch.id}`) || "[]");
        for (const evId of eventIds) {
          const raw = localStorage.getItem(`holoapps_event:${evId}`);
          if (raw) {
            try {
              toAnnounce.push(JSON.parse(raw));
            } catch(e) {}
          }
        }
      }
    }
  }
  
  console.log(`Announcing ${toAnnounce.length} local events over WebRTC...`);
  for (const ev of toAnnounce) {
    try {
      const eventJson = JSON.stringify(ev);
      const bytes = new TextEncoder().encode(eventJson);
      const kappa = console0.cn_put(bytes);
      console0.cn_announce(kappa);
    } catch (e) {
      console.error("Failed to announce event:", ev.id, e);
    }
  }
  if (window.cnLink && window.cnLink.is_open()) {
    console0.cn_pump(window.cnLink);
  }
}

// Periodic content discovery: check if remote peer has announced new states
const pendingEvents = [];

async function handleSuccessfulEventAdd(col, ev, isWorkspace, colId, isConfig = false) {
  const shell = window.shellInstance;
  if (!shell) return;
  shell.saveEventToStorage(ev);
  
  if (ev.header.kind === "epoch") {
    await col.unwrapAndStoreEpochKey(ev, shell.participant);
  }
  
  if (isConfig) {
    const configState = await col.render();
    shell.installedAppIds = configState.installedApps || [];
    shell.contacts = configState.contacts || [];
    shell.contactPools = configState.contactPools || [];
    shell.workspacesRefs = configState.workspaces || [];
    
    localStorage.setItem("holoapps_installed_apps", JSON.stringify(shell.installedAppIds));
    localStorage.setItem("holoapps_contacts", JSON.stringify(shell.contacts));
    localStorage.setItem("holoapps_contact_pools", JSON.stringify(shell.contactPools));
    localStorage.setItem("holoapps_workspaces", JSON.stringify(shell.workspacesRefs));
    
    await shell.loadWorkspaces();
  } else if (isWorkspace) {
    const state = await col.render();
    const ws = shell.workspaces.find(w => w.id === colId);
    if (ws) {
      ws.channels = state.channels;
      ws.members = state.members;
      if (shell.activeWorkspace && shell.activeWorkspace.id === colId) {
        shell.channels = state.channels;
        shell.activeWorkspace = { ...shell.activeWorkspace };
      }
    }
  } else {
    if (shell.activeChannel && shell.activeChannel.id === colId) {
      shell.activeChannel = { ...shell.activeChannel };
    }
  }

  // Retry pending events!
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < pendingEvents.length; i++) {
      const p = pendingEvents[i];
      // Check if parents are now present
      let parentsPresent = true;
      for (const parentId of p.ev.header.parents) {
        if (!p.col.events.has(parentId)) {
          parentsPresent = false;
          break;
        }
      }
      
      if (parentsPresent) {
        const added = await p.col.addEvent(p.ev);
        if (added) {
          console.log("WebRTC: Successfully resolved pending event:", p.ev.id, p.ev.header.kind);
          pendingEvents.splice(i, 1);
          i--; // adjust index
          progress = true;
          await handleSuccessfulEventAdd(p.col, p.ev, p.isWorkspace, p.colId, p.isConfig);
        }
      }
    }
  }
}

setInterval(async () => {
  if (window.cnLink && window.cnLink.is_open()) {
    const knownKappasJson = console0.cn_discover();
    if (knownKappasJson) {
      const knownKappas = JSON.parse(knownKappasJson);
      for (const kappa of knownKappas) {
        if (processedKappas.has(kappa)) continue;
        
        // Fetch event bytes
        console0.cn_fetch_start(kappa);
        let resolvedBytes = null;
        for (let i = 0; i < 30; i++) {
          console0.cn_pump(window.cnLink);
          const r = console0.cn_fetch_poll();
          if (r !== undefined) {
            resolvedBytes = r;
            break;
          }
          await new Promise(res => setTimeout(res, 50));
        }
        
        if (resolvedBytes) {
          processedKappas.add(kappa);
          try {
            const eventData = JSON.parse(new TextDecoder().decode(resolvedBytes));
            
            if (eventData.type === "HoloIdAnnouncement") {
              console.log("WebRTC received peer Holo ID announcement:", eventData.id, eventData.name);
              const shell = window.shellInstance;
              if (shell && eventData.id && eventData.id !== shell.participant?.id) {
                if (!shell.discoveredPeers.some(p => p.id === eventData.id)) {
                  shell.discoveredPeers.push(eventData);
                }
              }
              continue;
            }

            console.log("WebRTC received event:", eventData.id, eventData.header ? eventData.header.kind : "unknown");
            
            const ev = new Event(eventData.header, eventData.body, eventData.signature, eventData.id);
            const colId = ev.header ? ev.header.collection : null;
            if (!colId && (!ev.header || ev.header.kind !== "genesis")) continue;
            
            const shell = window.shellInstance;
            if (!shell) continue;
            
            // 1. Is it a workspace genesis event?
            if (ev.header.kind === "genesis" && ev.body.cleartext?.type === "Group") {
              const wsId = ev.id;
              if (!shell.workspaces.some(w => w.id === wsId)) {
                console.log("WebRTC: Discovered workspace genesis:", wsId, ev.body.cleartext.name);
                const col = new Collection(wsId, workspaceReducer);
                await col.addEvent(ev);
                shell.saveEventToStorage(ev);
                
                const savedRefs = JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]");
                if (!savedRefs.some(w => w.id === wsId)) {
                  savedRefs.push({ id: wsId, name: ev.body.cleartext.name });
                  localStorage.setItem("holoapps_workspaces", JSON.stringify(savedRefs));
                }
                
                const state = await col.render();
                const wsObj = {
                  id: wsId,
                  name: ev.body.cleartext.name,
                  collection: col,
                  channels: state.channels || [],
                  members: state.members || []
                };
                shell.workspaces.push(wsObj);
                
                if (!shell.activeWorkspace) {
                  shell.selectWorkspace(wsObj);
                }
              }
              continue;
            }
            
            // 2. Is it a channel genesis event?
            if (ev.header.kind === "genesis" && ev.body.cleartext?.type === "Conversation") {
              const chId = ev.id;
              shell.saveChannelReference(chId, ev.body.cleartext.name);
              shell.saveEventToStorage(ev);
              console.log("WebRTC: Discovered channel genesis:", chId, ev.body.cleartext.name);
              
              let ch = shell.channels.find(c => c.id === chId);
              if (!ch && shell.activeWorkspace) {
                ch = shell.activeWorkspace.channels.find(c => c.id === chId);
              }
              if (ch && ch.collection) {
                const added = await ch.collection.addEvent(ev);
                if (added) {
                  await handleSuccessfulEventAdd(ch.collection, ev, false, chId, false);
                }
              }
              continue;
            }
            
            // 3. Regular event, find collection
            let col = null;
            let isWorkspace = false;
            let isConfig = false;
            
            if (shell.configCollection && shell.configCollection.id === colId) {
              col = shell.configCollection;
              isConfig = true;
            } else if (shell.activeWorkspace && shell.activeWorkspace.id === colId) {
              col = shell.activeWorkspace.collection;
              isWorkspace = true;
            } else {
              const ws = shell.workspaces.find(w => w.id === colId);
              if (ws) {
                col = ws.collection;
                isWorkspace = true;
              } else {
                let ch = shell.channels.find(c => c.id === colId);
                if (!ch && shell.activeWorkspace) {
                  ch = shell.activeWorkspace.channels.find(c => c.id === colId);
                }
                if (ch) {
                  if (!ch.collection) {
                    const colObj = new Collection(ch.id, messengerReducer);
                    const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${ch.id}`) || "[]");
                    for (const evId of eventIds) {
                      const raw = localStorage.getItem(`holoapps_event:${evId}`);
                      if (raw) {
                        const evData = JSON.parse(raw);
                        const evObj = new Event(evData.header, evData.body, evData.signature, evData.id);
                        await colObj.addEvent(evObj);
                      }
                    }
                    ch.collection = colObj;
                  }
                  col = ch.collection;
                }
              }
            }
            
            if (col) {
              const added = await col.addEvent(ev);
              if (added) {
                await handleSuccessfulEventAdd(col, ev, isWorkspace, colId, isConfig);
              } else {
                // If it failed to add (due to causal dependency missing), queue it for retry
                if (!pendingEvents.some(p => p.ev.id === ev.id)) {
                  console.log("WebRTC: Event missing parents, queued for retry:", ev.id, ev.header.kind);
                  pendingEvents.push({ col, ev, isWorkspace, colId, isConfig });
                }
              }
            }
          } catch (e) {
            console.error("WebRTC: Failed to import fetched event:", e);
          }
        }
      }
    }
  }
}, 1000);


export function workspaceReducer(events) {
  const state = { name: "", channels: [], members: [] };
  if (!events || !Array.isArray(events)) return state;
  for (const ev of events) {
    if (!ev) continue;
    const payload = ev.payload || (ev.body ? ev.body.payload : null) || ev.body?.cleartext || {};
    const type = payload.type || "";
    const eventKind = ev.kind || ev.header?.kind || "";
    const author = ev.author || ev.header?.author || "";
    
    if (eventKind === "genesis" || type === "Group") {
      state.name = payload.name || "Unnamed Workspace";
      state.channels = payload.channels || [];
      state.members = payload.members || [author];
    } else if (eventKind === "add-channel" || (type === "Add" && payload.object?.type === "Conversation")) {
      const chId = payload.object?.id || payload.id;
      const chName = payload.object?.name || payload.name;
      if (chId && !state.channels.some(c => c.id === chId)) {
        state.channels.push({ id: chId, name: chName });
      }
    } else if (eventKind === "add-member" || (type === "Add" && payload.object?.type === "Person")) {
      const memberId = payload.object?.id || payload.id;
      if (memberId && !state.members.includes(memberId)) {
        state.members.push(memberId);
      }
    }
  }
  return state;
}

export function configReducer(events) {
  const state = {
    installedApps: [],
    contacts: [],
    contactPools: [],
    workspaces: []
  };
  if (!events || !Array.isArray(events)) return state;
  for (const ev of events) {
    if (!ev) continue;
    const payload = ev.payload || (ev.body ? ev.body.payload : null) || ev.body?.cleartext || {};
    const type = payload.type || "";
    const eventKind = ev.kind || ev.header?.kind || "";
    
    if (eventKind === "genesis" || type === "config-genesis") {
      state.installedApps = payload.installedApps || [];
      state.contacts = payload.contacts || [];
      state.contactPools = payload.contactPools || [];
      state.workspaces = payload.workspaces || [];
    } else if (type === "config-update") {
      if (payload.installedApps !== undefined) state.installedApps = payload.installedApps;
      if (payload.contacts !== undefined) state.contacts = payload.contacts;
      if (payload.contactPools !== undefined) state.contactPools = payload.contactPools;
      if (payload.workspaces !== undefined) state.workspaces = payload.workspaces;
    }
  }
  return state;
}

Alpine.data("shell", () => {
  return {
    get rawEventStream() {
      if (!this.activeWorkspace) return [];
      const col = this.activeWorkspace.collection;
      if (!col) return [];
      return Array.from(col.events.values())
        .sort((a, b) => b.header.clock - a.header.clock)
        .map(ev => {
          const payload = ev.body.cleartext || ev.decodedPayload || {};
          return JSON.stringify({
            "@context": "https://www.w3.org/ns/activitystreams",
            "id": `urn:uuid:${ev.id}`,
            "type": ev.header.kind === "genesis" ? "Group" : (payload.type || "Activity"),
            "actor": `did:key:${ev.header.author}`,
            "object": payload.object || payload,
            "header": ev.header
          }, null, 2);
        });
    },
    participant: null,
    configCollection: null,
    activeTab: "dashboard", // "dashboard", "apps", "channel", "contacts"
    installedAppIds: [],
    
    // Workspaces
    workspaces: [],
    activeWorkspace: null,
    
    // Fallback/Legacy
    channels: [],
    activeChannel: null,
    activeChannelView: { messages: [], rootMessages: [] },
    indexApps: [],
    
    // Contacts & Pools (AS2 & Schema.org)
    contacts: [],
    contactPools: [],
    selectedPoolId: "all",

    // Inputs & Modals state
    privateKeyHexInput: "",
    newWorkspaceName: "",
    newChannelName: "",
    newContactAlias: "",
    newContactId: "",
    newContactCurveId: "",
    newPoolName: "",
    inviteCodeInput: "",
    messageInput: "",
    editingMessage: null,
    editingMessageBody: "",
    
    showCreateChannelModal: false,
    showJoinChannelModal: false,
    showCreateWorkspaceModal: false,
    showJoinWorkspaceModal: false,
    showAddContactModal: false,
    showCreatePoolModal: false,
    showIdentityDetails: false,
    discoveredPeers: [],
    passPreview: null,
    holoIdInput: "",
    nicknameInput: localStorage.getItem("holoapps_nickname") || "Operator",
    
    topBarTitle: "Workspace Dashboard",

    async init() {
      window.shellInstance = this;
      // 1. Load or Boot Identity
      const savedJwk = localStorage.getItem("holoapps_participant_jwk");
      if (savedJwk) {
        try {
          const jwkObj = JSON.parse(savedJwk);
          this.participant = await Participant.importJwk(jwkObj);
          console.log("Existing participant identity loaded:", this.participant.id);
          await this.onIdentityReady();
        } catch (e) {
          console.error("Failed to restore identity:", e);
        }
      }

      // Warm up StandardsValidator context schemas
      try {
        const origin = window.location.origin;
        const base = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'));
        const { StandardsValidator } = await import("./standards-validator.js");
        await StandardsValidator.init(`${origin}${base}/`);
      } catch (e) {
        console.error("Failed to initialize StandardsValidator context in apps.js:", e);
      }
    },

    async onIdentityReady() {
      const configColId = this.participant.id + "-config";
      this.configCollection = new Collection(configColId, configReducer);
      
      const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${configColId}`) || "[]");
      for (const evId of eventIds) {
        const raw = localStorage.getItem(`holoapps_event:${evId}`);
        if (raw) {
          try {
            const evData = JSON.parse(raw);
            const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
            await this.configCollection.addEvent(ev);
          } catch(e) {}
        }
      }

      const mockManifest = await createMessengerApp(this.participant);
      this.indexApps = [mockManifest];

      if (this.configCollection.events.size === 0) {
        const defaultPools = [
          {
            "@context": "https://www.w3.org/ns/activitystreams",
            "type": "Collection",
            "id": "pool:default",
            "name": "Default"
          },
          {
            "@context": "https://www.w3.org/ns/activitystreams",
            "type": "Collection",
            "id": "pool:work",
            "name": "Work"
          },
          {
            "@context": "https://www.w3.org/ns/activitystreams",
            "type": "Collection",
            "id": "pool:friends",
            "name": "Friends"
          }
        ];
        
        const selfContact = {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Person",
          "id": this.participant.id,
          "name": "Me (Operator)",
          "curveId": this.participant.curveId,
          "pools": ["pool:default"]
        };

        const genesisEvent = await Event.create({
          kind: "genesis",
          author: this.participant.id,
          collectionId: configColId,
          payload: {
            type: "config-genesis",
            installedApps: [mockManifest.id],
            contacts: [selfContact],
            contactPools: defaultPools,
            workspaces: []
          }
        }, this.participant);
        
        genesisEvent.header.collection = genesisEvent.id;
        const signPayload = canonicalJson({ header: genesisEvent.header, body: genesisEvent.body });
        genesisEvent.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, signPayload);
        genesisEvent.id = await sha256(signPayload);
        
        this.configCollection.id = genesisEvent.id;
        await this.configCollection.addEvent(genesisEvent);
        this.saveEventToStorage(genesisEvent);
      }

      const configState = await this.configCollection.render();

      this.installedAppIds = configState.installedApps;
      this.contacts = configState.contacts;
      this.contactPools = configState.contactPools;
      
      localStorage.setItem("holoapps_installed_apps", JSON.stringify(this.installedAppIds));
      localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
      localStorage.setItem("holoapps_contact_pools", JSON.stringify(this.contactPools));

      await this.loadWorkspaces();
    },

    async createNewIdentity() {
      const p = await Participant.create();
      this.participant = p;
      const jwk = await p.exportJwk();
      localStorage.setItem("holoapps_participant_jwk", JSON.stringify(jwk));
      localStorage.setItem("holoapps_identity_key", p.id);
      localStorage.setItem("holoapps_curve_key", p.curveId);
      localStorage.setItem("holoapps_nickname", this.nicknameInput || "Operator");
      console.log("New self-sovereign participant identity created:", p.id);
      await this.onIdentityReady();
    },

    async loadExistingIdentity() {
      try {
        let payloadStr = this.privateKeyHexInput.trim();
        let decoded = "";
        if (payloadStr.startsWith("encrypted:")) {
          const passphrase = prompt("This backup is encrypted. Please enter the passphrase to decrypt it:");
          if (!passphrase) {
            alert("Passphrase is required to import this account.");
            return;
          }
          try {
            decoded = await decryptPayload(payloadStr, passphrase);
          } catch (err) {
            console.error("Passphrase decryption failed:", err);
            alert("Failed to decrypt account. Ensure the passphrase is correct.");
            return;
          }
        } else {
          decoded = base64Decode(payloadStr);
        }

        if (!decoded) {
          alert("Failed to import account. Ensure you pasted a valid Account Backup Payload.");
          return;
        }
        const jwkObj = JSON.parse(decoded);
        const p = await Participant.importJwk(jwkObj);
        this.participant = p;
        localStorage.setItem("holoapps_participant_jwk", JSON.stringify(jwkObj));
        localStorage.setItem("holoapps_identity_key", p.id);
        localStorage.setItem("holoapps_curve_key", p.curveId);
        localStorage.setItem("holoapps_nickname", this.nicknameInput || "Operator");
        this.privateKeyHexInput = "";
        
        await this.onIdentityReady();
        
        alert("Account imported successfully!");
      } catch (e) {
        console.error(e);
        alert("Failed to import account. Ensure you pasted a valid Account Backup Payload.");
      }
    },

    isAppInstalled(appId) {
      return this.installedAppIds.includes(appId);
    },

    async installIndexApp(app) {
      if (!this.isAppInstalled(app.id)) {
        this.installedAppIds.push(app.id);
        await this.writeConfigUpdate({ installedApps: this.installedAppIds });
        console.log("Installed app:", app.name);
      }
    },

    async writeConfigUpdate(fields) {
      if (!this.configCollection) return;
      const p = this.participant;
      const parents = Array.from(this.configCollection.heads);
      let maxClock = 0;
      for (const pId of parents) {
        const parent = this.configCollection.events.get(pId);
        if (parent && parent.header.clock > maxClock) maxClock = parent.header.clock;
      }

      const ev = await Event.create({
        kind: "config-update",
        author: p.id,
        collectionId: this.configCollection.id,
        parents,
        clock: maxClock + 1,
        payload: {
          type: "config-update",
          ...fields
        }
      }, p);

      const added = await this.configCollection.addEvent(ev);
      if (added) {
        this.saveEventToStorage(ev);
        const configState = await this.configCollection.render();
        if (fields.installedApps !== undefined) {
          this.installedAppIds = configState.installedApps;
          localStorage.setItem("holoapps_installed_apps", JSON.stringify(this.installedAppIds));
        }
        if (fields.contacts !== undefined) {
          this.contacts = configState.contacts;
          localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
        }
        if (fields.contactPools !== undefined) {
          this.contactPools = configState.contactPools;
          localStorage.setItem("holoapps_contact_pools", JSON.stringify(this.contactPools));
        }
        if (fields.workspaces !== undefined) {
          this.workspacesRefs = configState.workspaces;
          localStorage.setItem("holoapps_workspaces", JSON.stringify(this.workspacesRefs));
        }
      }
    },

    // Contacts & Pools
    async loadContactsAndPools() {
      const defaultPools = [
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Collection",
          "id": "pool:default",
          "name": "Default"
        },
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Collection",
          "id": "pool:work",
          "name": "Work"
        },
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Collection",
          "id": "pool:friends",
          "name": "Friends"
        }
      ];
      
      const savedPools = localStorage.getItem("holoapps_contact_pools");
      if (savedPools) {
        this.contactPools = JSON.parse(savedPools);
      } else {
        this.contactPools = defaultPools;
        localStorage.setItem("holoapps_contact_pools", JSON.stringify(this.contactPools));
      }

      const savedContacts = localStorage.getItem("holoapps_contacts");
      if (savedContacts) {
        this.contacts = JSON.parse(savedContacts);
      } else {
        const selfContact = {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Person",
          "id": this.participant.id,
          "name": "Me (Operator)",
          "curveId": this.participant.curveId,
          "pools": ["pool:default"]
        };
        this.contacts = [selfContact];
        localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
      }
    },

    createContact() {
      if (!this.newContactId || !this.newContactCurveId) return;
      const newPerson = {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Person",
        "id": this.newContactId.trim(),
        "name": this.newContactAlias.trim() || "Contact " + this.newContactId.substring(0, 6),
        "curveId": this.newContactCurveId.trim(),
        "pools": ["pool:default"]
      };
      this.contacts = this.contacts.filter(c => c.id !== newPerson.id);
      this.contacts.push(newPerson);
      this.writeConfigUpdate({ contacts: this.contacts });
      
      this.newContactId = "";
      this.newContactCurveId = "";
      this.newContactAlias = "";
      this.showAddContactModal = false;
    },

    discoverContact(id, curveId, alias) {
      if (id === this.participant.id) return;
      const exists = this.contacts.find(c => c.id === id);
      if (exists) {
        if (curveId && exists.curveId !== curveId) {
          exists.curveId = curveId;
          this.writeConfigUpdate({ contacts: this.contacts });
        }
        return;
      }
      const newPerson = {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Person",
        "id": id,
        "name": alias || "Operator " + id.substring(0, 8),
        "curveId": curveId || "",
        "pools": ["pool:default"]
      };
      this.contacts.push(newPerson);
      this.writeConfigUpdate({ contacts: this.contacts });
      console.log("Discovered contact automatically:", id);
    },

    deleteContact(contactId) {
      this.contacts = this.contacts.filter(c => c.id !== contactId);
      this.writeConfigUpdate({ contacts: this.contacts });
    },

    createPool() {
      if (!this.newPoolName) return;
      const newPool = {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Collection",
        "id": "pool:" + crypto.randomUUID(),
        "name": this.newPoolName
      };
      this.contactPools.push(newPool);
      this.writeConfigUpdate({ contactPools: this.contactPools });
      this.newPoolName = "";
      this.showCreatePoolModal = false;
    },

    toggleContactPool(contactId, poolId) {
      const contact = this.contacts.find(c => c.id === contactId);
      if (!contact) return;
      if (!contact.pools) contact.pools = [];
      
      if (contact.pools.includes(poolId)) {
        contact.pools = contact.pools.filter(p => p !== poolId);
      } else {
        contact.pools.push(poolId);
      }
      this.writeConfigUpdate({ contacts: this.contacts });
    },

    // Workspaces
    async loadWorkspaces() {
      const prevActiveWorkspaceId = this.activeWorkspace?.id;
      const prevActiveChannelId = this.activeChannel?.id;
      const prevActiveTab = this.activeTab;

      let saved = [];
      if (this.configCollection) {
        const configState = await this.configCollection.render();
        saved = configState.workspaces || [];
      }
      if (!saved || saved.length === 0) {
        saved = JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]");
      }
      this.workspaces = [];
      
      for (const wsRef of saved) {
        const col = new Collection(wsRef.id, workspaceReducer);
        const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${wsRef.id}`) || "[]");
        for (const evId of eventIds) {
          const raw = localStorage.getItem(`holoapps_event:${evId}`);
          if (raw) {
            try {
              const evData = JSON.parse(raw);
              const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
              await col.addEvent(ev);
            } catch(e) {}
          }
        }
        
        const state = await col.render();
        this.workspaces.push({
          id: wsRef.id,
          name: state.name || wsRef.name,
          collection: col,
          channels: state.channels || [],
          members: state.members || []
        });
      }

      if (this.workspaces.length === 0) {
        await this.bootstrapDefaultWorkspace();
      } else {
        let targetWs = null;
        if (prevActiveWorkspaceId) {
          targetWs = this.workspaces.find(w => w.id === prevActiveWorkspaceId);
        }
        this.activeWorkspace = targetWs || this.workspaces[0];
        this.channels = this.activeWorkspace.channels;

        if (prevActiveTab === "channel" && prevActiveChannelId) {
          const targetCh = this.channels.find(c => c.id === prevActiveChannelId);
          if (targetCh) {
            await this.selectChannel(targetCh);
          } else {
            this.activeChannel = null;
            this.activeTab = "dashboard";
          }
        }
      }
    },

    async bootstrapDefaultWorkspace() {
      console.log("Bootstrapping default workspace 'Local Swarm'...");
      
      // 1. Create #general channel genesis
      const genChanGenesis = await Event.create({
        kind: "genesis",
        author: this.participant.id,
        collectionId: "temp-channel-general",
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Conversation",
          "name": "general",
          "published": new Date().toISOString()
        }
      }, this.participant);
      genChanGenesis.header.collection = genChanGenesis.id;
      const genSignPayload = canonicalJson({ header: genChanGenesis.header, body: genChanGenesis.body });
      genChanGenesis.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, genSignPayload);
      genChanGenesis.id = await sha256(genSignPayload);
      this.saveEventToStorage(genChanGenesis);
      this.saveChannelReference(genChanGenesis.id, "general");

      // 2. Create workspace genesis
      const wsGenesis = await Event.create({
        kind: "genesis",
        author: this.participant.id,
        collectionId: "temp-workspace-genesis",
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Group",
          "name": "Local Swarm",
          "channels": [
            { "type": "Conversation", "id": genChanGenesis.id, "name": "general" }
          ],
          "members": [this.participant.id]
        }
      }, this.participant);
      wsGenesis.header.collection = wsGenesis.id;
      const wsSignPayload = canonicalJson({ header: wsGenesis.header, body: wsGenesis.body });
      wsGenesis.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, wsSignPayload);
      wsGenesis.id = await sha256(wsSignPayload);
      this.saveEventToStorage(wsGenesis);

      // Save references
      const savedRefs = [{ id: wsGenesis.id, name: "Local Swarm" }];
      localStorage.setItem("holoapps_workspaces", JSON.stringify(savedRefs));
      if (this.configCollection) {
        await this.writeConfigUpdate({ workspaces: savedRefs });
      }

      const col = new Collection(wsGenesis.id, workspaceReducer);
      await col.addEvent(wsGenesis);
      const state = await col.render();
      
      const wsObj = {
        id: wsGenesis.id,
        name: "Local Swarm",
        collection: col,
        channels: state.channels || [],
        members: state.members || []
      };
      
      this.workspaces.push(wsObj);
      this.activeWorkspace = wsObj;
      this.channels = wsObj.channels;
    },

    async createWorkspace() {
      if (!this.newWorkspaceName) return;

      // 1. Create general channel
      const genChanGenesis = await Event.create({
        kind: "genesis",
        author: this.participant.id,
        collectionId: "temp-channel-gen",
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Conversation",
          "name": "general",
          "published": new Date().toISOString()
        }
      }, this.participant);

      try {
        const { StandardsValidator } = await import("./standards-validator.js");
        StandardsValidator.validateActivityStreams(genChanGenesis.body.payload || genChanGenesis.body.cleartext, "Conversation");
      } catch (err) {
        console.error("Standards compliance check failed on general channel genesis:", err.message);
        alert(`Standards compliance check failed: ${err.message}`);
        return;
      }

      genChanGenesis.header.collection = genChanGenesis.id;
      const genSignPayload = canonicalJson({ header: genChanGenesis.header, body: genChanGenesis.body });
      genChanGenesis.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, genSignPayload);
      genChanGenesis.id = await sha256(genSignPayload);
      this.saveEventToStorage(genChanGenesis);
      this.saveChannelReference(genChanGenesis.id, "general");

      // 2. Create workspace
      const wsGenesis = await Event.create({
        kind: "genesis",
        author: this.participant.id,
        collectionId: "temp-workspace-genesis",
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Group",
          "name": this.newWorkspaceName,
          "channels": [
            { "type": "Conversation", "id": genChanGenesis.id, "name": "general" }
          ],
          "members": [this.participant.id]
        }
      }, this.participant);

      try {
        const { StandardsValidator } = await import("./standards-validator.js");
        StandardsValidator.validateActivityStreams(wsGenesis.body.payload || wsGenesis.body.cleartext, "Group");
      } catch (err) {
        console.error("Standards compliance check failed on workspace genesis:", err.message);
        alert(`Standards compliance check failed: ${err.message}`);
        return;
      }
      wsGenesis.header.collection = wsGenesis.id;
      const wsSignPayload = canonicalJson({ header: wsGenesis.header, body: wsGenesis.body });
      wsGenesis.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, wsSignPayload);
      wsGenesis.id = await sha256(wsSignPayload);
      this.saveEventToStorage(wsGenesis);

      const savedRefs = [];
      if (this.configCollection) {
        const configState = await this.configCollection.render();
        savedRefs.push(...(configState.workspaces || []));
      } else {
        savedRefs.push(...JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]"));
      }
      savedRefs.push({ id: wsGenesis.id, name: this.newWorkspaceName });
      localStorage.setItem("holoapps_workspaces", JSON.stringify(savedRefs));
      if (this.configCollection) {
        await this.writeConfigUpdate({ workspaces: savedRefs });
      }

      const col = new Collection(wsGenesis.id, workspaceReducer);
      await col.addEvent(wsGenesis);
      const state = await col.render();
      
      const wsObj = {
        id: wsGenesis.id,
        name: this.newWorkspaceName,
        collection: col,
        channels: state.channels || [],
        members: state.members || []
      };
      
      this.workspaces.push(wsObj);
      this.activeWorkspace = wsObj;
      this.channels = wsObj.channels;
      
      this.newWorkspaceName = "";
      this.showCreateWorkspaceModal = false;
    },

    async createChannel() {
      if (!this.newChannelName || !this.activeWorkspace) return;

      // 1. Genesis event
      const genChanGenesis = await Event.create({
        kind: "genesis",
        author: this.participant.id,
        collectionId: "temp-channel-custom",
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Conversation",
          "name": this.newChannelName,
          "published": new Date().toISOString()
        }
      }, this.participant);

      try {
        const { StandardsValidator } = await import("./standards-validator.js");
        StandardsValidator.validateActivityStreams(genChanGenesis.body.payload || genChanGenesis.body.cleartext, "Conversation");
      } catch (err) {
        console.error("Standards compliance check failed on custom channel genesis:", err.message);
        alert(`Standards compliance check failed: ${err.message}`);
        return;
      }
      genChanGenesis.header.collection = genChanGenesis.id;
      const genSignPayload = canonicalJson({ header: genChanGenesis.header, body: genChanGenesis.body });
      genChanGenesis.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, genSignPayload);
      genChanGenesis.id = await sha256(genSignPayload);
      this.saveEventToStorage(genChanGenesis);
      this.saveChannelReference(genChanGenesis.id, this.newChannelName);

      // 2. Add channel to workspace
      const wsCol = this.activeWorkspace.collection;
      const parents = Array.from(wsCol.heads);
      let maxClock = 0;
      for (const pId of parents) {
        const parent = wsCol.events.get(pId);
        if (parent && parent.header.clock > maxClock) maxClock = parent.header.clock;
      }

      const addEvent = await Event.create({
        kind: "add-channel",
        author: this.participant.id,
        collectionId: wsCol.id,
        parents,
        clock: maxClock + 1,
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Add",
          "object": {
            "type": "Conversation",
            "id": genChanGenesis.id,
            "name": this.newChannelName
          },
          "target": {
            "type": "Group",
            "id": wsCol.id
          }
        }
      }, this.participant);

      try {
        const { StandardsValidator } = await import("./standards-validator.js");
        StandardsValidator.validateActivityStreams(addEvent.body.payload || addEvent.body.cleartext, "Add");
      } catch (err) {
        console.error("Standards compliance check failed on add channel event:", err.message);
        alert(`Standards compliance check failed: ${err.message}`);
        return;
      }

      await wsCol.addEvent(addEvent);
      this.saveEventToStorage(addEvent);

      const state = await wsCol.render();
      this.activeWorkspace.channels = state.channels;
      this.channels = state.channels;

      this.newChannelName = "";
      this.showCreateChannelModal = false;
    },

    async addMemberToActiveWorkspace() {
      if (!this.activeWorkspace) return;
      const memberId = prompt("Enter Member's Account ID:");
      if (!memberId) return;

      const wsCol = this.activeWorkspace.collection;
      const parents = Array.from(wsCol.heads);
      let maxClock = 0;
      for (const pId of parents) {
        const parent = wsCol.events.get(pId);
        if (parent && parent.header.clock > maxClock) maxClock = parent.header.clock;
      }

      const addEvent = await Event.create({
        kind: "add-member",
        author: this.participant.id,
        collectionId: wsCol.id,
        parents,
        clock: maxClock + 1,
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Add",
          "object": {
            "type": "Person",
            "id": memberId
          },
          "target": {
            "type": "Group",
            "id": wsCol.id
          }
        }
      }, this.participant);

      try {
        const { StandardsValidator } = await import("./standards-validator.js");
        StandardsValidator.validateActivityStreams(addEvent.body.payload || addEvent.body.cleartext, "Add");
      } catch (err) {
        console.error("Standards compliance check failed on add member event:", err.message);
        alert(`Standards compliance check failed: ${err.message}`);
        return;
      }

      await wsCol.addEvent(addEvent);
      this.saveEventToStorage(addEvent);

      const state = await wsCol.render();
      this.activeWorkspace.members = state.members;
      
      alert("Member added to workspace!");
    },

    async promoteWorkspaceMember(memberId) {
      if (!this.activeWorkspace) return;
      const wsCol = this.activeWorkspace.collection;
      const parents = Array.from(wsCol.heads);
      let maxClock = 0;
      for (const pId of parents) {
        const parent = wsCol.events.get(pId);
        if (parent && parent.header.clock > maxClock) maxClock = parent.header.clock;
      }
      const addEvent = await Event.create({
        kind: "add-member",
        author: this.participant.id,
        collectionId: wsCol.id,
        parents,
        clock: maxClock + 1,
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Add",
          "object": {
            "type": "Person",
            "id": memberId,
            "capabilities": ["read", "write", "admin"]
          },
          "target": {
            "type": "Group",
            "id": wsCol.id
          }
        }
      }, this.participant);
      
      try {
        const { StandardsValidator } = await import("./standards-validator.js");
        StandardsValidator.validateActivityStreams(addEvent.body.payload || addEvent.body.cleartext, "Add");
      } catch (err) {
        console.error("Standards compliance check failed on promote workspace member event:", err.message);
        alert(`Standards compliance check failed: ${err.message}`);
        return;
      }

      await wsCol.addEvent(addEvent);
      this.saveEventToStorage(addEvent);
      
      const state = await wsCol.render();
      this.activeWorkspace.members = state.members;
      alert("Member promoted to Workspace Admin!");
    },

    async demoteWorkspaceMember(memberId) {
      if (!this.activeWorkspace) return;
      const wsCol = this.activeWorkspace.collection;
      const parents = Array.from(wsCol.heads);
      let maxClock = 0;
      for (const pId of parents) {
        const parent = wsCol.events.get(pId);
        if (parent && parent.header.clock > maxClock) maxClock = parent.header.clock;
      }
      const addEvent = await Event.create({
        kind: "add-member",
        author: this.participant.id,
        collectionId: wsCol.id,
        parents,
        clock: maxClock + 1,
        payload: {
          "@context": "https://www.w3.org/ns/activitystreams",
          "type": "Add",
          "object": {
            "type": "Person",
            "id": memberId,
            "capabilities": ["read", "write"]
          },
          "target": {
            "type": "Group",
            "id": wsCol.id
          }
        }
      }, this.participant);
      
      try {
        const { StandardsValidator } = await import("./standards-validator.js");
        StandardsValidator.validateActivityStreams(addEvent.body.payload || addEvent.body.cleartext, "Add");
      } catch (err) {
        console.error("Standards compliance check failed on demote workspace member event:", err.message);
        alert(`Standards compliance check failed: ${err.message}`);
        return;
      }

      await wsCol.addEvent(addEvent);
      this.saveEventToStorage(addEvent);
      
      const state = await wsCol.render();
      this.activeWorkspace.members = state.members;
      alert("Member demoted to Workspace Member!");
    },

    selectWorkspace(ws) {
      this.activeWorkspace = ws;
      this.channels = ws.channels;
      this.activeChannel = null;
      this.activeTab = "dashboard";
      this.topBarTitle = `Workspace: ${ws.name}`;
    },

    async exportActiveWorkspaceInvite() {
      if (!this.activeWorkspace) return;
      try {
        const wsCol = this.activeWorkspace.collection;
        const allEvents = Array.from(wsCol.events.values()).map(ev => ({
          header: ev.header,
          body: ev.body,
          signature: ev.signature,
          id: ev.id
        }));

        const channelBundles = [];
        for (const ch of this.activeWorkspace.channels) {
          const chEventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${ch.id}`) || "[]");
          const chEvents = [];
          for (const evId of chEventIds) {
            const raw = localStorage.getItem(`holoapps_event:${evId}`);
            if (raw) chEvents.push(JSON.parse(raw));
          }
          channelBundles.push({
            id: ch.id,
            name: ch.name,
            events: chEvents
          });
        }

        const payload = {
          type: "WorkspaceInvite",
          id: wsCol.id,
          name: this.activeWorkspace.name,
          genesisEvent: allEvents.find(e => e.header.kind === "genesis"),
          events: allEvents.filter(e => e.header.kind !== "genesis"),
          channels: channelBundles
        };

        const serialized = base64Encode(JSON.stringify(payload));
        try {
          navigator.clipboard.writeText(serialized).catch(err => {
            console.log("Failed to copy to clipboard automatically:", err);
          });
        } catch (e) {
          // Ignore synchronous clipboard API errors
        }
        prompt("Share this Workspace Invite Code:", serialized);
        console.log("Generated Workspace Invite Code:\n", serialized);
      } catch (e) {
        console.error("exportActiveWorkspaceInvite error:", e);
        alert("Failed to export workspace invite.");
      }
    },

    async joinWorkspace() {
      if (!this.inviteCodeInput) return;
      try {
        const decoded = base64Decode(this.inviteCodeInput.trim());
        if (!decoded) {
          console.error("joinWorkspace error: Failed to decode invite code. Input may be invalid base64 or truncated:", this.inviteCodeInput);
          alert("Failed to join workspace. Invalid workspace invite code.");
          return;
        }
        const payload = JSON.parse(decoded);
        if (payload && payload.type === "WorkspaceInvite" && payload.id && payload.genesisEvent) {
          const gData = payload.genesisEvent;
          const genesis = new Event(gData.header, gData.body, gData.signature, gData.id);
          
          if (this.workspaces.some(w => w.id === genesis.id)) {
            const existing = this.workspaces.find(w => w.id === genesis.id);
            this.activeWorkspace = existing;
            this.channels = existing.channels;
            this.inviteCodeInput = "";
            this.showJoinWorkspaceModal = false;
            alert("Joined workspace successfully!");
            return;
          }
          
          const col = new Collection(genesis.id, workspaceReducer);
          await col.addEvent(genesis);
          this.saveEventToStorage(genesis);

          if (payload.events) {
            for (const evData of payload.events) {
              const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
              await col.addEvent(ev);
              this.saveEventToStorage(ev);
            }
          }

          if (payload.channels) {
            for (const chBundle of payload.channels) {
              this.saveChannelReference(chBundle.id, chBundle.name);
              for (const evData of chBundle.events) {
                const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
                this.saveEventToStorage(ev);
              }
            }
          }

          const savedRefs = [];
          if (this.configCollection) {
            const configState = await this.configCollection.render();
            savedRefs.push(...(configState.workspaces || []));
          } else {
            savedRefs.push(...JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]"));
          }
          if (!savedRefs.some(w => w.id === genesis.id)) {
            savedRefs.push({ id: genesis.id, name: payload.name || "Joined Workspace" });
            localStorage.setItem("holoapps_workspaces", JSON.stringify(savedRefs));
            if (this.configCollection) {
              await this.writeConfigUpdate({ workspaces: savedRefs });
            }
          }

          const state = await col.render();
          const wsObj = {
            id: genesis.id,
            name: payload.name || "Joined Workspace",
            collection: col,
            channels: state.channels || [],
            members: state.members || []
          };

          this.workspaces.push(wsObj);
          this.activeWorkspace = wsObj;
          this.channels = wsObj.channels;
          
          this.inviteCodeInput = "";
          this.showJoinWorkspaceModal = false;
          alert("Joined workspace successfully!");
        } else {
          console.error("joinWorkspace error: Invalid payload structure or missing required properties:", payload);
          alert("Invalid workspace invite payload.");
        }
      } catch (e) {
        console.error("joinWorkspace error: Exception caught during processing:", e);
        alert("Failed to join workspace.");
      }
    },

    // Legacy fallback support for loading/saving single channels directly
    async loadChannels() {
      await this.loadWorkspaces();
    },

    saveEventToStorage(event) {
      localStorage.setItem(`holoapps_event:${event.id}`, JSON.stringify(event));
      const colId = event.header.collection;
      const idsToSave = [colId];
      if (event.header.kind === "genesis" || event.header.collection === event.id) {
        idsToSave.push(event.id);
      }
      for (const cid of idsToSave) {
        if (!cid) continue;
        const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${cid}`) || "[]");
        if (!eventIds.includes(event.id)) {
          eventIds.push(event.id);
          localStorage.setItem(`holoapps_col_events:${cid}`, JSON.stringify(eventIds));
        }
      }

      // Real-time broadcast over WebRTC
      if (window.cnLink && window.cnLink.is_open()) {
        try {
          const eventJson = JSON.stringify(event);
          const bytes = new TextEncoder().encode(eventJson);
          const kappa = console0.cn_put(bytes);
          console0.cn_announce(kappa);
          console0.cn_pump(window.cnLink);
          console.log("WebRTC: Broadcasted event:", event.id, event.header.kind);
        } catch (e) {
          console.error("WebRTC: Failed to broadcast event:", event.id, e);
        }
      }
    },

    saveChannelReference(id, name) {
      const saved = JSON.parse(localStorage.getItem("holoapps_channels") || "[]");
      if (!saved.some(c => c.id === id)) {
        saved.push({ id, name });
        localStorage.setItem("holoapps_channels", JSON.stringify(saved));
      }
    },

    async selectChannel(ch) {
      if (!ch.collection) {
        const col = new Collection(ch.id, messengerReducer);
        const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${ch.id}`) || "[]");
        for (const evId of eventIds) {
          const raw = localStorage.getItem(`holoapps_event:${evId}`);
          if (raw) {
            const evData = JSON.parse(raw);
            const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
            await col.addEvent(ev);
          }
        }
        ch.collection = col;
      }
      this.activeChannel = ch;
      this.activeTab = "channel";
      this.topBarTitle = `Channel: ${ch.name}`;
    },

    selectTab(tab) {
      this.activeTab = tab;
      this.activeChannel = null;
      this.topBarTitle = tab === "dashboard" ? "Workspace Dashboard" : "Gateway App Index Store";
    },

    async joinChannel() {
      if (!this.inviteCodeInput) return;
      try {
        const decoded = base64Decode(this.inviteCodeInput.trim());
        if (!decoded) {
          alert("Invalid invite code format");
          return;
        }
        const payload = JSON.parse(decoded);
        if (payload && payload.id && payload.genesisEvent) {
          // Recreate genesis event
          const gData = payload.genesisEvent;
          const genesis = new Event(gData.header, gData.body, gData.signature, gData.id);
          
          const col = new Collection(genesis.id, messengerReducer);
          await col.addEvent(genesis);
          this.saveEventToStorage(genesis);
          this.saveChannelReference(genesis.id, payload.name || "Joined Channel");

          // Save and add other linked events
          if (payload.events) {
            for (const evData of payload.events) {
              const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
              await col.addEvent(ev);
              this.saveEventToStorage(ev);
            }
          }

          // Unwrap and store epoch keys that we have access to
          for (const ev of col.events.values()) {
            if (ev.header.kind === "epoch") {
              await col.unwrapAndStoreEpochKey(ev, this.participant);
            }
          }

          const existingCh = this.channels.find(c => c.id === genesis.id);
          if (existingCh) {
            existingCh.collection = col;
            if (payload.name) {
              existingCh.name = payload.name;
            }
          } else {
            this.channels.push({
              id: genesis.id,
              name: payload.name || "Joined Channel",
              collection: col
            });
          }

          this.inviteCodeInput = "";
          this.showJoinChannelModal = false;
          alert("Joined channel successfully!");
        }
      } catch (e) {
        console.error(e);
        alert("Invalid invite code format");
      }
    },

    async exportIdentity() {
      try {
        const jwkObj = await this.participant.exportJwk();
        const cleartext = JSON.stringify(jwkObj);
        const passphrase = prompt("Enter a passphrase to encrypt your account backup (leave blank to export unencrypted):");
        let serialized = "";
        if (passphrase) {
          serialized = await encryptPayload(cleartext, passphrase);
        } else {
          serialized = base64Encode(cleartext);
        }
        prompt("Copy this Complete Account Backup Payload:", serialized);
      } catch (e) {
        console.error(e);
        alert("Failed to export account.");
      }
    },

    clearIdentity() {
      if (confirm("Are you sure you want to log out and clear your account from this browser? Make sure you backed up your account payload!")) {
        localStorage.removeItem("holoapps_participant_jwk");
        localStorage.removeItem("holoapps_identity_key");
        localStorage.removeItem("holoapps_curve_key");
        window.location.reload();
      }
    },

    getHoloId() {
      if (!this.participant) return "";
      const nickname = localStorage.getItem("holoapps_nickname") || "Operator";
      const payload = {
        id: this.participant.id,
        curveId: this.participant.curveId
      };
      const b64 = base64Encode(JSON.stringify(payload));
      return `@${nickname}:${b64}`;
    },

    parseHoloId(str) {
      if (!str || !str.startsWith("@") || !str.includes(":")) {
        return null;
      }
      try {
        const firstColonIdx = str.indexOf(":");
        const nickname = str.substring(1, firstColonIdx);
        const b64 = str.substring(firstColonIdx + 1);
        const decoded = base64Decode(b64);
        if (!decoded) return null;
        const parsed = JSON.parse(decoded);
        if (parsed && parsed.id && parsed.curveId) {
          return {
            name: nickname,
            id: parsed.id,
            curveId: parsed.curveId
          };
        }
      } catch (e) {
        console.error("Failed to parse Holo ID:", e);
      }
      return null;
    },

    async importHoloIdContact() {
      if (!this.holoIdInput) return;
      const parsed = this.parseHoloId(this.holoIdInput.trim());
      if (!parsed) {
        alert("Invalid Holo ID format. Expected format: @nickname:base64...");
        return;
      }
      this.newContactAlias = parsed.name;
      this.newContactId = parsed.id;
      this.newContactCurveId = parsed.curveId;
      await this.createContact();
      this.holoIdInput = "";
      this.showAddContactModal = false;
    },

    addDiscoveredContact(peer) {
      this.discoverContact(peer.id, peer.curveId, peer.name);
      this.discoveredPeers = this.discoveredPeers.filter(p => p.id !== peer.id);
    },

    copyHoloId() {
      const holoId = this.getHoloId();
      if (!holoId) return;
      try {
        navigator.clipboard.writeText(holoId).then(() => {
          console.log("Copied Holo ID to clipboard successfully");
        }).catch(err => {
          console.log("Clipboard writeText failed:", err);
          prompt("Copy your Holo ID:", holoId);
        });
      } catch (e) {
        console.log("Clipboard API unavailable, showing fallback:", e);
        prompt("Copy your Holo ID:", holoId);
      }
    },

    validateAndPreviewPass(code) {
      if (!code) {
        this.passPreview = null;
        return;
      }
      try {
        const decoded = base64Decode(code.trim());
        if (!decoded) {
          this.passPreview = null;
          return;
        }
        const payload = JSON.parse(decoded);
        if (payload && payload.type === "WorkspaceInvite" && payload.id && payload.genesisEvent) {
          const creator = payload.genesisEvent.header.author;
          this.passPreview = {
            name: payload.name || "Joined Workspace",
            creator: creator ? creator.substring(0, 16) + "..." : "Unknown"
          };
        } else {
          this.passPreview = null;
        }
      } catch (e) {
        this.passPreview = null;
      }
    },

    generateAvatarSvg(pubkey) {
      if (!pubkey) {
        return `<circle cx="50" cy="50" r="40" fill="url(#grad-default)" />
                <defs>
                  <linearGradient id="grad-default" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#4f46e5" />
                    <stop offset="100%" stop-color="#ec4899" />
                  </linearGradient>
                </defs>`;
      }
      let hash = 0;
      for (let i = 0; i < pubkey.length; i++) {
        hash = (hash << 5) - hash + pubkey.charCodeAt(i);
        hash |= 0;
      }
      
      const hue1 = Math.abs(hash % 360);
      const hue2 = (hue1 + 120) % 360;
      const shapeType = Math.abs(hash >> 2) % 3;
      
      const col1 = `hsl(${hue1}, 70%, 50%)`;
      const col2 = `hsl(${hue2}, 80%, 40%)`;
      const colBg = `hsl(${(hue1 + 240) % 360}, 20%, 15%)`;
      
      const gradId = `grad-${pubkey.substring(0, 8)}-${Math.abs(hash)}`;
      
      let shapes = "";
      if (shapeType === 0) {
        shapes = `
          <circle cx="50" cy="50" r="30" fill="${col2}" opacity="0.8" />
          <circle cx="35" cy="35" r="15" fill="#fff" opacity="0.9" />
          <circle cx="65" cy="50" r="12" fill="#fff" opacity="0.5" />
        `;
      } else if (shapeType === 1) {
        shapes = `
          <polygon points="50,15 15,75 85,75" fill="${col2}" opacity="0.8" />
          <polygon points="50,30 30,70 70,70" fill="#fff" opacity="0.6" />
          <circle cx="50" cy="55" r="10" fill="#fff" opacity="0.9" />
        `;
      } else {
        shapes = `
          <polygon points="50,15 80,50 50,85 20,50" fill="${col2}" opacity="0.8" />
          <polygon points="50,25 70,50 50,75 30,50" fill="#fff" opacity="0.6" />
          <circle cx="50" cy="50" r="8" fill="#fff" opacity="0.9" />
        `;
      }
      
      return `
        <defs>
          <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${col1}" />
            <stop offset="100%" stop-color="${colBg}" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#${gradId})" />
        ${shapes}
      `;
    }
  };
});

import AlpineBlock from "./alpine-block.js";

async function registerBlockStandalone(tagName, blockFile) {
  const resp = await fetch("/blocks/" + blockFile);
  if (resp.ok) {
    const text = await resp.text();
    const template = document.createElement("template");
    template.id = `playground-${tagName}`;
    template.innerHTML = text;
    document.body.appendChild(template);
    
    if (!customElements.get(tagName)) {
      class AlpineBlockSFC extends AlpineBlock {}
      AlpineBlockSFC.pkg = "playground";
      AlpineBlockSFC.tagName = tagName;
      AlpineBlockSFC.template = template;
      customElements.define(tagName, AlpineBlockSFC);
    }
  }
}

// Dynamically compile and register the messenger-block SFC component
await registerBlockStandalone("messenger-block", "messenger-block.html");

Alpine.start();
