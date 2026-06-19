import Alpine from "./alpine-fork.js";
import { Participant, Event, Collection, App, AppIndex, Shell, canonicalJson, sha256, HoloAppsCrypto } from "./holo-apps.js";
import { messengerReducer, createMessengerApp } from "./holo-messenger.js";
import init, { Console, WebRtcLink } from "../../../pkg/holospaces_web.js";

// Initialize Substrate WebAssembly
await init();
const console0 = new Console();
console.log("Substrate console active in Holo-Apps Shell");

Alpine.data("shell", () => {
  return {
    participant: null,
    activeTab: "dashboard", // "dashboard", "apps", "channel"
    installedAppIds: [],
    channels: [], // array of { id, name, collection }
    activeChannel: null,
    activeChannelView: { messages: [], rootMessages: [] },
    indexApps: [], // Apps available in App Index
    
    // Inputs & Modals state
    privateKeyHexInput: "",
    newChannelName: "",
    inviteCodeInput: "",
    messageInput: "",
    editingMessage: null,
    editingMessageBody: "",
    
    showCreateChannelModal: false,
    showJoinChannelModal: false,
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

      // 5. Active channel poll loop to refresh message projection
      setInterval(async () => {
        if (this.activeChannel) {
          await this.refreshChannelView();
        }
      }, 1000);
    },

    async onIdentityReady() {
      // 2. Load gateway app indexes
      const mockManifest = await createMessengerApp(this.participant);
      this.indexApps = [mockManifest];

      // 3. Load installed apps
      this.installedAppIds = JSON.parse(localStorage.getItem("holoapps_installed_apps") || "[]");

      // 4. Load joined channels (Collections)
      await this.loadChannels();
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
        const jwkObj = JSON.parse(atob(this.privateKeyHexInput.trim()));
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

    async loadChannels() {
      const savedChannels = JSON.parse(localStorage.getItem("holoapps_channels") || "[]");
      this.channels = [];
      for (const ch of savedChannels) {
        const col = new Collection(ch.id, messengerReducer);
        
        // Re-hydrate existing events from substrate / LocalStorage
        const eventIds = JSON.parse(localStorage.getItem(`holoapps_col_events:${ch.id}`) || "[]");
        for (const evId of eventIds) {
          const raw = localStorage.getItem(`holoapps_event:${evId}`);
          if (raw) {
            const evData = JSON.parse(raw);
            const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
            await col.addEvent(ev);
          }
        }
        
        this.channels.push({
          id: ch.id,
          name: ch.name,
          collection: col
        });
      }
    },

    async createChannel() {
      if (!this.newChannelName) return;

      // 1. Genesis Event to bootstrap the channel collection
      const genesis = await Event.create({
        kind: "genesis",
        author: this.participant.id,
        collectionId: "temp-genesis-id", // will resolve to hash address
        payload: { name: this.newChannelName, timestamp: Date.now() }
      }, this.participant);

      // Mutate collection ID to genesis ID
      genesis.header.collection = genesis.id;
      // Re-sign to finalize
      const payloadToSign = canonicalJson({ header: genesis.header, body: genesis.body });
      genesis.signature = await HoloAppsCrypto.sign(this.participant.signKeys.privateKey, payloadToSign);
      genesis.id = await sha256(payloadToSign);

      const col = new Collection(genesis.id, messengerReducer);
      await col.addEvent(genesis);

      // Save event content and collection reference
      this.saveEventToStorage(genesis);
      this.saveChannelReference(genesis.id, this.newChannelName);

      this.channels.push({
        id: genesis.id,
        name: this.newChannelName,
        collection: col
      });

      this.newChannelName = "";
      this.showCreateChannelModal = false;
      console.log("Created channel collection:", genesis.id);
    },

    saveEventToStorage(event) {
      localStorage.setItem(`holoapps_event:${event.id}`, JSON.stringify(event));
      
      // Update collection's index of events
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

    async selectChannel(ch) {
      this.activeChannel = ch;
      this.activeTab = "channel";
      this.topBarTitle = `Channel: ${ch.name}`;
      await this.refreshChannelView();
      
      // Scroll to bottom
      this.$nextTick(() => {
        const container = document.getElementById("chat-messages-container");
        if (container) container.scrollTop = container.scrollHeight;
      });
    },

    selectTab(tab) {
      this.activeTab = tab;
      this.activeChannel = null;
      this.topBarTitle = tab === "dashboard" ? "Workspace Dashboard" : "Gateway App Index Store";
    },

    async refreshChannelView() {
      if (!this.activeChannel) return;
      this.activeChannelView = await this.activeChannel.collection.render();
    },

    async postMessage() {
      if (!this.messageInput || !this.activeChannel) return;

      const col = this.activeChannel.collection;
      const parents = Array.from(col.heads);
      
      // Compute Lamport clock based on parents
      let maxClock = 0;
      for (const pId of parents) {
        const p = col.events.get(pId);
        if (p && p.header.clock > maxClock) maxClock = p.header.clock;
      }

      const msgEvent = await Event.create({
        kind: "message",
        author: this.participant.id,
        collectionId: col.id,
        parents,
        clock: maxClock + 1,
        payload: { body: this.messageInput, timestamp: Date.now() }
      }, this.participant);

      const added = await col.addEvent(msgEvent);
      if (added) {
        this.saveEventToStorage(msgEvent);
        await this.refreshChannelView();
        this.messageInput = "";
        
        // Scroll to bottom
        this.$nextTick(() => {
          const container = document.getElementById("chat-messages-container");
          if (container) container.scrollTop = container.scrollHeight;
        });
      }
    },

    async triggerReaction(msg, symbol) {
      if (!this.activeChannel) return;
      const col = this.activeChannel.collection;
      const parents = Array.from(col.heads);
      
      let maxClock = 0;
      for (const pId of parents) {
        const p = col.events.get(pId);
        if (p && p.header.clock > maxClock) maxClock = p.header.clock;
      }

      const reactEvent = await Event.create({
        kind: "reaction",
        author: this.participant.id,
        collectionId: col.id,
        parents,
        clock: maxClock + 1,
        payload: { target: msg.id, symbol }
      }, this.participant);

      const added = await col.addEvent(reactEvent);
      if (added) {
        this.saveEventToStorage(reactEvent);
        await this.refreshChannelView();
      }
    },

    toggleReaction(msg, symbol) {
      this.triggerReaction(msg, symbol);
    },

    startEdit(msg) {
      this.editingMessage = msg;
      this.editingMessageBody = msg.body;
    },

    async saveEdit() {
      if (!this.editingMessage || !this.activeChannel) return;
      const col = this.activeChannel.collection;
      const parents = Array.from(col.heads);
      
      let maxClock = 0;
      for (const pId of parents) {
        const p = col.events.get(pId);
        if (p && p.header.clock > maxClock) maxClock = p.header.clock;
      }

      const editEvent = await Event.create({
        kind: "edit",
        author: this.participant.id,
        collectionId: col.id,
        parents,
        clock: maxClock + 1,
        payload: { target: this.editingMessage.id, body: this.editingMessageBody }
      }, this.participant);

      const added = await col.addEvent(editEvent);
      if (added) {
        this.saveEventToStorage(editEvent);
        await this.refreshChannelView();
        this.editingMessage = null;
      }
    },

    async joinChannel() {
      if (!this.inviteCodeInput) return;
      try {
        const payload = JSON.parse(atob(this.inviteCodeInput.trim()));
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

    async generateInvitePrompt() {
      if (!this.activeChannel) return;
      const targetId = prompt("Enter Invitee's Identity Address (κ):");
      if (!targetId) return;
      const targetCurveId = prompt("Enter Invitee's ECDH Public Exchange Key:");
      if (!targetCurveId) return;

      const col = this.activeChannel.collection;

      // 1. Author a membership grant event
      const parents = Array.from(col.heads);
      let maxClock = 0;
      for (const pId of parents) {
        const p = col.events.get(pId);
        if (p && p.header.clock > maxClock) maxClock = p.header.clock;
      }

      const grantEvent = await Event.create({
        kind: "membership",
        author: this.participant.id,
        collectionId: col.id,
        parents,
        clock: maxClock + 1,
        payload: {
          target: targetId,
          action: "grant",
          capabilities: ["read", "write"],
          curveId: targetCurveId
        }
      }, this.participant);

      const grantAdded = await col.addEvent(grantEvent);
      if (!grantAdded) {
        alert("Failed to grant membership. Are you an admin of this channel?");
        return;
      }
      this.saveEventToStorage(grantEvent);

      // 2. Generate and wrap a new/existing epoch key
      let epochKey = col.epochKeys.get(col.currentEpochId);
      if (!epochKey) {
        epochKey = await HoloAppsCrypto.generateEpochKey();
      }

      // Wrap for both target and self (for forward access)
      const myWrappedKey = await HoloAppsCrypto.wrapEpochKey(epochKey, this.participant.curveKeys.privateKey, this.participant.curveId);
      const targetWrappedKey = await HoloAppsCrypto.wrapEpochKey(epochKey, this.participant.curveKeys.privateKey, targetCurveId);

      const epochParents = Array.from(col.heads);
      let epochMaxClock = 0;
      for (const pId of epochParents) {
        const p = col.events.get(pId);
        if (p && p.header.clock > epochMaxClock) epochMaxClock = p.header.clock;
      }

      const epochEvent = await Event.create({
        kind: "epoch",
        author: this.participant.id,
        collectionId: col.id,
        parents: epochParents,
        clock: epochMaxClock + 1,
        payload: {
          senderCurveId: this.participant.curveId,
          wrappedKeys: {
            [this.participant.id]: myWrappedKey,
            [targetId]: targetWrappedKey
          }
        }
      }, this.participant);

      const epochAdded = await col.addEvent(epochEvent);
      if (!epochAdded) {
        alert("Failed to add epoch key rotation event.");
        return;
      }
      this.saveEventToStorage(epochEvent);
      col.epochKeys.set(epochEvent.id, epochKey);
      col.currentEpochId = epochEvent.id;

      // 3. Serialize invite payload
      const allEvents = Array.from(col.events.values()).map(ev => ({
        header: ev.header,
        body: ev.body,
        signature: ev.signature,
        id: ev.id
      }));

      const genesisEvent = allEvents.find(e => e.header.kind === "genesis");
      const inviteObj = {
        id: col.id,
        name: this.activeChannel.name,
        genesisEvent,
        events: allEvents.filter(e => e.header.kind !== "genesis")
      };

      const serialized = btoa(JSON.stringify(inviteObj));
      prompt("Share this Invite Code with the invitee:", serialized);
    },

    async exportIdentity() {
      try {
        const jwkObj = await this.participant.exportJwk();
        const serialized = btoa(JSON.stringify(jwkObj));
        prompt("Copy this Complete Backup Payload (Base64-encoded JWKs):", serialized);
      } catch (e) {
        console.error(e);
        alert("Failed to export identity.");
      }
    }
  };
});

Alpine.start();
