import Alpine from "./alpine-fork.js";
import { Participant, Event, Collection, App, AppIndex, Shell, canonicalJson, sha256, HoloAppsCrypto, base64Encode, base64Decode } from "./holo-apps.js";
import { messengerReducer, createMessengerApp } from "./holo-messenger.js";
import init, { Console, WebRtcLink } from "../../pkg/holospaces_web.js";

// Initialize Substrate WebAssembly
await init();
const console0 = new Console();
console.log("Substrate console active in Holo-Apps Shell");

export function workspaceReducer(events) {
  const state = { name: "", channels: [], members: [] };
  for (const ev of events) {
    const payload = ev.payload || (ev.body ? ev.body.payload : {}) || {};
    const type = payload.type || "";
    const eventKind = ev.kind || (ev.header ? ev.header.kind : "");
    const author = ev.author || (ev.header ? ev.header.author : "");
    
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

Alpine.data("shell", () => {
  return {
    participant: null,
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
    
    topBarTitle: "Workspace Dashboard",

    async init() {
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
    },

    async onIdentityReady() {
      // 2. Load gateway app indexes
      const mockManifest = await createMessengerApp(this.participant);
      this.indexApps = [mockManifest];

      // 3. Load installed apps
      this.installedAppIds = JSON.parse(localStorage.getItem("holoapps_installed_apps") || "[]");
      if (this.installedAppIds.length === 0) {
        this.installedAppIds.push(mockManifest.id);
        localStorage.setItem("holoapps_installed_apps", JSON.stringify(this.installedAppIds));
      }

      // 4. Load Contacts & Pools
      await this.loadContactsAndPools();

      // 5. Load Workspaces (and channels)
      await this.loadWorkspaces();
    },

    async createNewIdentity() {
      const p = await Participant.create();
      this.participant = p;
      const jwk = await p.exportJwk();
      localStorage.setItem("holoapps_participant_jwk", JSON.stringify(jwk));
      localStorage.setItem("holoapps_identity_key", p.id);
      localStorage.setItem("holoapps_curve_key", p.curveId);
      console.log("New self-sovereign participant identity created:", p.id);
      await this.onIdentityReady();
    },

    async loadExistingIdentity() {
      try {
        const jwkObj = JSON.parse(base64Decode(this.privateKeyHexInput.trim()));
        const p = await Participant.importJwk(jwkObj);
        this.participant = p;
        localStorage.setItem("holoapps_participant_jwk", JSON.stringify(jwkObj));
        localStorage.setItem("holoapps_identity_key", p.id);
        localStorage.setItem("holoapps_curve_key", p.curveId);
        this.privateKeyHexInput = "";
        
        await this.onIdentityReady();
        
        alert("Identity imported successfully!");
      } catch (e) {
        console.error(e);
        alert("Failed to import identity. Ensure you pasted a valid Backup Payload.");
      }
    },

    isAppInstalled(appId) {
      return this.installedAppIds.includes(appId);
    },

    async installIndexApp(app) {
      if (!this.isAppInstalled(app.id)) {
        this.installedAppIds.push(app.id);
        localStorage.setItem("holoapps_installed_apps", JSON.stringify(this.installedAppIds));
        console.log("Installed app:", app.name);
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
      localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
      
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
          localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
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
      localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
      console.log("Discovered contact automatically:", id);
    },

    deleteContact(contactId) {
      this.contacts = this.contacts.filter(c => c.id !== contactId);
      localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
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
      localStorage.setItem("holoapps_contact_pools", JSON.stringify(this.contactPools));
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
      localStorage.setItem("holoapps_contacts", JSON.stringify(this.contacts));
    },

    // Workspaces
    async loadWorkspaces() {
      const saved = JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]");
      this.workspaces = [];
      
      for (const wsRef of saved) {
        const col = new Collection(wsRef.id, workspaceReducer);
        const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${wsRef.id}`) || "[]");
        for (const evId of eventIds) {
          const raw = localStorage.getItem(`holoapps_event:${evId}`);
          if (raw) {
            const evData = JSON.parse(raw);
            const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
            await col.addEvent(ev);
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
        this.activeWorkspace = this.workspaces[0];
        this.channels = this.activeWorkspace.channels;
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
          "timestamp": Date.now()
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
      const savedRefs = JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]");
      savedRefs.push({ id: wsGenesis.id, name: "Local Swarm" });
      localStorage.setItem("holoapps_workspaces", JSON.stringify(savedRefs));

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
          "timestamp": Date.now()
        }
      }, this.participant);
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
      wsGenesis.header.collection = wsGenesis.id;
      const wsSignPayload = canonicalJson({ header: wsGenesis.header, body: wsGenesis.body });
      wsGenesis.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, wsSignPayload);
      wsGenesis.id = await sha256(wsSignPayload);
      this.saveEventToStorage(wsGenesis);

      const savedRefs = JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]");
      savedRefs.push({ id: wsGenesis.id, name: this.newWorkspaceName });
      localStorage.setItem("holoapps_workspaces", JSON.stringify(savedRefs));

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
          "timestamp": Date.now()
        }
      }, this.participant);
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
      const memberId = prompt("Enter Member's Public Key (κ):");
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

      await wsCol.addEvent(addEvent);
      this.saveEventToStorage(addEvent);

      const state = await wsCol.render();
      this.activeWorkspace.members = state.members;
      
      alert("Member added to workspace!");
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
        prompt("Share this Workspace Invite Code:", serialized);
      } catch (e) {
        console.error(e);
        alert("Failed to export workspace invite.");
      }
    },

    async joinWorkspace() {
      if (!this.inviteCodeInput) return;
      try {
        const payload = JSON.parse(base64Decode(this.inviteCodeInput.trim()));
        if (payload && payload.type === "WorkspaceInvite" && payload.id && payload.genesisEvent) {
          const gData = payload.genesisEvent;
          const genesis = new Event(gData.header, gData.body, gData.signature, gData.id);
          
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

          const savedRefs = JSON.parse(localStorage.getItem("holoapps_workspaces") || "[]");
          if (!savedRefs.some(w => w.id === genesis.id)) {
            savedRefs.push({ id: genesis.id, name: payload.name || "Joined Workspace" });
            localStorage.setItem("holoapps_workspaces", JSON.stringify(savedRefs));
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
          alert("Invalid workspace invite payload.");
        }
      } catch (e) {
        console.error(e);
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
      const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${colId}`) || "[]");
      if (!eventIds.includes(event.id)) {
        eventIds.push(event.id);
        localStorage.setItem(`holoapps_col_events:${colId}`, JSON.stringify(eventIds));
      }
    },

    saveChannelReference(id, name) {
      const saved = JSON.parse(localStorage.getItem("holoapps_channels") || "[]");
      if (!saved.some(c => c.id === id)) {
        saved.push({ id, name });
        localStorage.setItem("holoapps_channels", JSON.stringify(saved));
      }
    },

    selectChannel(ch) {
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
        const payload = JSON.parse(base64Decode(this.inviteCodeInput.trim()));
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

          this.channels.push({
            id: genesis.id,
            name: payload.name || "Joined Channel",
            collection: col
          });

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
        const serialized = base64Encode(JSON.stringify(jwkObj));
        prompt("Copy this Complete Backup Payload (Base64-encoded JWKs):", serialized);
      } catch (e) {
        console.error(e);
        alert("Failed to export identity.");
      }
    },

    clearIdentity() {
      if (confirm("Are you sure you want to log out and clear your identity from this browser? Make sure you backed up your keys!")) {
        localStorage.removeItem("holoapps_participant_jwk");
        localStorage.removeItem("holoapps_identity_key");
        localStorage.removeItem("holoapps_curve_key");
        this.participant = null;
        window.location.reload();
      }
    }
  };
});

import AlpineBlock from "./alpine-block.js";

async function registerBlockStandalone(tagName, blockFile) {
  const resp = await fetch("blocks/" + blockFile);
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
