import { Participant, Event, Collection, App, AppIndex, Shell, canonicalJson, sha256, HoloAppsCrypto, base64Encode, base64Decode } from "../crates/holospaces-web/web/assets/scripts/holo-apps.js";
import { messengerReducer, createMessengerApp } from "../crates/holospaces-web/web/assets/scripts/holo-messenger.js";
import { StandardsValidator } from "../crates/holospaces-web/web/assets/scripts/standards-validator.js";
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function runTests() {
  console.log("==============================================");
  console.log("🧪 Running holo-apps Architecture Validation Suite...");
  console.log("==============================================");

  try {
    // Mock fetch for StandardsValidator inside Node unit tests
    global.fetch = async (url) => {
      if (url.includes("assets/schemas/") || url.includes("schemas/")) {
        const filename = url.split("/").pop();
        const filePath = path.join(__dirname, "schemas", filename);
        const content = fs.readFileSync(filePath, "utf-8");
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(content)
        };
      }
      throw new Error(`Unsupported fetch URL in Node test: ${url}`);
    };

    // 1. Participant Cryptography Axes
    console.log("1. Testing Cryptographic Axes (Signature, Curve, Hash)...");
    const alice = await Participant.create();
    const bob = await Participant.create();
    assert.ok(alice.id, "Alice should have a valid signature ID (identity κ)");
    assert.ok(alice.curveId, "Alice should have a valid curve ID");
    assert.notStrictEqual(alice.id, bob.id, "Alice and Bob should have unique identities");
    
    // SignatureAxis Verification
    const testText = "coordination-free, content-addressed";
    const sig = await Event.create({ kind: "test", author: alice.id, collectionId: "test-col" }, alice);
    const isValidSig = await sig.verify();
    assert.ok(isValidSig, "Event signature must be valid under Alice's identity");

    // CurveAxis Epoch Key Wrapping/Unwrapping
    const rawEpochKey = await HoloAppsCrypto.generateEpochKey();
    const wrappedKey = await HoloAppsCrypto.wrapEpochKey(rawEpochKey, alice.curveKeys.privateKey, bob.curveId);
    assert.ok(wrappedKey, "Epoch key wrapping should return a valid stringified envelope");
    
    const unwrappedKey = await HoloAppsCrypto.unwrapEpochKey(wrappedKey, bob.curveKeys.privateKey, alice.curveId);
    assert.ok(unwrappedKey, "Epoch key unwrapping must succeed and return a CryptoKey");
    console.log("✓ Cryptographic Axis validation PASSED");

    // 2. Event Integrity (Identity-is-Content)
    console.log("\n2. Testing Event Integrity & Canonicalization...");
    const ev1 = await Event.create({
      kind: "message",
      author: alice.id,
      collectionId: "channel-1",
      parents: ["parent-2", "parent-1"], // Unordered parents list
      payload: { b: 2, a: 1 } // Unordered payload
    }, alice);

    const ev2 = await Event.create({
      kind: "message",
      author: alice.id,
      collectionId: "channel-1",
      parents: ["parent-1", "parent-2"], // Sorted parents list
      payload: { a: 1, b: 2 } // Ordered payload
    }, alice);

    assert.strictEqual(ev1.id, ev2.id, "Canonicalization must ensure equal content produces the exact same hash address (identity-is-content)");
    console.log("✓ Event Canonicalization validation PASSED");

    // 3. Collection & Capability Attenuation (SEC-2 / SEC-8)
    console.log("\n3. Testing Collection capabilities & membership attenuation...");
    
    // Create genesis event to bootstrap the collection
    const genesis = await Event.create({
      kind: "genesis",
      author: alice.id,
      collectionId: "genesis-id",
      payload: { name: "Holo Room" }
    }, alice);

    const col = new Collection(genesis.id, messengerReducer);
    const addedGen = await col.addEvent(genesis);
    assert.ok(addedGen, "Genesis event must be successfully added to bootstrap the collection");

    // Alice is an admin; she grants Bob "write" permissions
    const bobGrant = await Event.create({
      kind: "membership",
      author: alice.id,
      collectionId: genesis.id,
      parents: [genesis.id],
      payload: { target: bob.id, action: "grant", capabilities: ["read", "write"], curveId: bob.curveId }
    }, alice);

    const addedGrant = await col.addEvent(bobGrant);
    assert.ok(addedGrant, "Alice should be allowed to grant Bob membership");
    assert.deepStrictEqual(col.capabilities.get(bob.id), ["read", "write"], "Bob should receive read and write permissions");

    // Bob authors a message (valid: Bob has write permissions)
    const bobMsg = await Event.create({
      kind: "message",
      author: bob.id,
      collectionId: genesis.id,
      parents: [bobGrant.id],
      clock: 2,
      payload: { body: "Hello from Bob!" }
    }, bob);

    const addedBobMsg = await col.addEvent(bobMsg);
    assert.ok(addedBobMsg, "Bob's message should be accepted as he holds 'write' capability");

    // Charlie authors a message without permission (invalid)
    const charlie = await Participant.create();
    const charlieMsg = await Event.create({
      kind: "message",
      author: charlie.id,
      collectionId: genesis.id,
      parents: [bobMsg.id],
      payload: { body: "Intruder Charlie" }
    }, charlie);

    const addedCharlieMsg = await col.addEvent(charlieMsg);
    assert.ok(!addedCharlieMsg, "Charlie's message must be rejected since Charlie lacks write capability");
    console.log("✓ Capability Attenuation validation PASSED");

    // 4. Confidentiality Epoch Rotations & Forward Secrecy
    console.log("\n4. Testing Confidentiality Epochs & Rotation...");
    const secretEpochKey = await HoloAppsCrypto.generateEpochKey();
    
    // Wrap key for Bob
    const wrappedKeyForBob = await HoloAppsCrypto.wrapEpochKey(secretEpochKey, alice.curveKeys.privateKey, bob.curveId);
    
    const epochEvent = await Event.create({
      kind: "epoch",
      author: alice.id,
      collectionId: genesis.id,
      parents: [bobMsg.id],
      clock: 3,
      payload: {
        senderCurveId: alice.curveId,
        wrappedKeys: {
          [bob.id]: wrappedKeyForBob
        }
      }
    }, alice);

    const addedEpoch = await col.addEvent(epochEvent);
    assert.ok(addedEpoch, "Epoch event must be successfully added");

    // Bob unwraps key
    const BobUnwrapped = await col.unwrapAndStoreEpochKey(epochEvent, bob);
    assert.ok(BobUnwrapped, "Bob must be able to unwrap and store the epoch key");

    // Alice posts encrypted payload
    const encMsg = await Event.create({
      kind: "message",
      author: alice.id,
      collectionId: genesis.id,
      parents: [epochEvent.id],
      epochId: epochEvent.id,
      clock: 4,
      payload: { body: "Secret Agent Payload" }
    }, alice, secretEpochKey);

    const addedEnc = await col.addEvent(encMsg);
    assert.ok(addedEnc, "Encrypted message must be added");

    // Bob decrypts payload during render
    const renderOutput = await col.render();
    assert.strictEqual(renderOutput.messages[1].body, "Secret Agent Payload", "Bob should be able to decrypt the message correctly");

    // Charlie cannot unwrap epoch key since it wasn't wrapped for him
    const CharlieUnwrapped = await col.unwrapAndStoreEpochKey(epochEvent, charlie);
    assert.ok(!CharlieUnwrapped, "Charlie should not be able to unwrap key");
    console.log("✓ Confidentiality Rotation validation PASSED");

    // 5. Deterministic Topological Sorting (Tiebreaks)
    console.log("\n5. Testing Deterministic Topological Sort (tie-breaks on clock)...");
    
    // Concurrent events (parents are the same)
    const concurrentA = await Event.create({
      kind: "message",
      author: alice.id,
      collectionId: genesis.id,
      parents: [encMsg.id],
      clock: 5
    }, alice);
    const concurrentB = await Event.create({
      kind: "message",
      author: bob.id,
      collectionId: genesis.id,
      parents: [encMsg.id],
      clock: 5
    }, bob);

    await col.addEvent(concurrentA);
    await col.addEvent(concurrentB);

    const sorted = col.topologicalSort([concurrentA.id, concurrentB.id]);
    const expectedFirst = concurrentA.id.localeCompare(concurrentB.id) < 0 ? concurrentA : concurrentB;
    assert.strictEqual(sorted[sorted.length - 2].id, expectedFirst.id, "Topological sort must tie-break deterministically via ID collation");
    console.log("✓ Topological Sort tie-breaks PASSED");

    // 6. Messenger Reducer Validation
    console.log("\n6. Testing Messenger Reducer rules...");
    const msgEvents = [
      { id: "msg-1", author: alice.id, clock: 1, kind: "message", payload: { body: "Hello World" } },
      { id: "edit-1", author: alice.id, clock: 2, kind: "edit", payload: { target: "msg-1", body: "Hello World (Edited)" } },
      { id: "react-1", author: bob.id, clock: 3, kind: "reaction", payload: { target: "msg-1", symbol: "👍" } }
    ];

    const reduced = messengerReducer(msgEvents);
    assert.strictEqual(reduced.messages.length, 1, "There should be 1 base message");
    assert.strictEqual(reduced.messages[0].body, "Hello World (Edited)", "Edit should replace the rendered body");
    assert.strictEqual(reduced.messages[0].reactions[0].symbol, "👍", "Reactions should aggregate");
    assert.strictEqual(reduced.messages[0].reactions[0].count, 1, "Reaction count should update");

    // Test deletion rule
    const deletedEvents = [
      ...msgEvents,
      { id: "del-1", author: alice.id, clock: 4, kind: "delete", payload: { target: "msg-1" } }
    ];
    const reducedDeleted = messengerReducer(deletedEvents);
    assert.strictEqual(reducedDeleted.messages.length, 0, "Deleted message must be retracted from the list");

    console.log("✓ Messenger Reducer validation PASSED");

    // 7. W3C ActivityStreams 2.0 & Schema.org Conformance Test
    console.log("\n7. Testing W3C ActivityStreams 2.0 & Schema.org Standards Conformance...");
    
    // Import external validation artifacts (standards contexts)
    const asContextPath = path.join(__dirname, "schemas/activitystreams-context.json");
    const schemaContextPath = path.join(__dirname, "schemas/schema-org-context.json");

    const asContext = JSON.parse(fs.readFileSync(asContextPath, "utf-8"))["@context"];
    const schemaContext = JSON.parse(fs.readFileSync(schemaContextPath, "utf-8"))["@context"];

    function validateAgainstContext(obj, contextObj, name = "Object") {
      for (const key of Object.keys(obj)) {
        if (key === "@context" || key === "type" || key === "id" || key === "@type" || key === "@id") {
          continue;
        }
        
        const isDefined = (key in contextObj);
        
        if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
          const nestedContext = obj[key]["@context"] ? 
            (obj[key]["@context"].includes("schema.org") ? schemaContext : asContext) : contextObj;
          validateAgainstContext(obj[key], nestedContext, `${name}.${key}`);
        } else if (Array.isArray(obj[key])) {
          for (let i = 0; i < obj[key].length; i++) {
            if (typeof obj[key][i] === "object" && obj[key][i] !== null) {
              const nestedContext = obj[key][i]["@context"] ? 
                (obj[key][i]["@context"].includes("schema.org") ? schemaContext : asContext) : contextObj;
              validateAgainstContext(obj[key][i], nestedContext, `${name}.${key}[${i}]`);
            }
          }
        }
        
        const allowedExtensions = ["curveId", "channels", "members"];
        if (!isDefined && !allowedExtensions.includes(key)) {
          throw new Error(`Property '${key}' in ${name} is not defined in the imported standards context!`);
        }
      }
    }

    function validateActivityStreams(payload, expectedType) {
      assert.strictEqual(payload["@context"], "https://www.w3.org/ns/activitystreams", "Must include W3C ActivityStreams context");
      assert.strictEqual(payload.type, expectedType, `Must be of type '${expectedType}'`);
      validateAgainstContext(payload, asContext, expectedType);
    }

    // A. Validate Person (Contact)
    const personObj = {
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "Person",
      "id": alice.id,
      "name": "Alice",
      "curveId": alice.curveId
    };
    validateActivityStreams(personObj, "Person");
    assert.ok(personObj.id.startsWith("04"), "Person ID should be a valid public key hex representation");
    assert.ok(personObj.curveId.startsWith("04"), "Person Curve ID should be a valid public key hex representation");

    // B. Validate Group (Workspace Org)
    const groupObj = {
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "Group",
      "name": "Local Swarm",
      "channels": [{ "type": "Conversation", "id": "chan-1", "name": "general" }],
      "members": [alice.id]
    };
    validateActivityStreams(groupObj, "Group");
    assert.strictEqual(groupObj.name, "Local Swarm");
    assert.strictEqual(groupObj.channels[0].type, "Conversation");

    // C. Validate Create Note Activity (Message)
    const createMsgPayload = {
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "Create",
      "object": {
        "type": "Note",
        "content": "Hello standard world",
        "published": new Date().toISOString()
      }
    };
    validateActivityStreams(createMsgPayload, "Create");
    assert.strictEqual(createMsgPayload.object.type, "Note");
    assert.strictEqual(createMsgPayload.object.content, "Hello standard world");
    assert.ok(!isNaN(Date.parse(createMsgPayload.object.published)), "Published should be a valid ISO Date string");

    // D. Validate Update Note Activity (Edit)
    const updateMsgPayload = {
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "Update",
      "object": {
        "type": "Note",
        "id": "msg-1",
        "content": "Hello standard world (edited)"
      }
    };
    validateActivityStreams(updateMsgPayload, "Update");
    assert.strictEqual(updateMsgPayload.object.type, "Note");
    assert.strictEqual(updateMsgPayload.object.id, "msg-1");
    assert.strictEqual(updateMsgPayload.object.content, "Hello standard world (edited)");

    // E. Validate Like Activity (Reaction)
    const likePayload = {
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "Like",
      "object": "msg-1",
      "content": "👍"
    };
    validateActivityStreams(likePayload, "Like");
    assert.strictEqual(likePayload.object, "msg-1");
    assert.strictEqual(likePayload.content, "👍");

    // F. Validate that our reducer handles these standard payloads successfully!
    const standardEvents = [
      { id: "msg-1", author: alice.id, clock: 1, kind: "message", payload: createMsgPayload },
      { id: "std-edit-1", author: alice.id, clock: 2, kind: "edit", payload: updateMsgPayload },
      { id: "std-react-1", author: bob.id, clock: 3, kind: "reaction", payload: likePayload }
    ];
    const stdReduced = messengerReducer(standardEvents);
    assert.strictEqual(stdReduced.messages.length, 1, "Standard Create activity should reduce to 1 message");
    assert.strictEqual(stdReduced.messages[0].body, "Hello standard world (edited)", "Standard Update activity should apply edits correctly");
    assert.strictEqual(stdReduced.messages[0].reactions[0].symbol, "👍", "Standard Like activity should apply reactions correctly");

    // G. Validate a Schema.org Person object using the imported Schema.org context
    const schemaPersonObj = {
      "@context": "https://schema.org/docs/jsonldcontext.json",
      "type": "Person",
      "name": "Alice Developer",
      "email": "alice@holospaces.org",
      "url": "https://holospaces.org/alice"
    };
    assert.strictEqual(schemaPersonObj["@context"], "https://schema.org/docs/jsonldcontext.json");
    validateAgainstContext(schemaPersonObj, schemaContext, "SchemaPerson");

    console.log("✓ W3C ActivityStreams 2.0 & Schema.org Standards Conformance PASSED");

    // 8. Workspace Replication and P2P Synchronization Validation
    console.log("\n8. Testing Workspace Replication (Export/Import/Sync)...");
    
    // Setup a workspace with 2 channels for Alice
    const wsGenesis = await Event.create({
      kind: "genesis",
      author: alice.id,
      collectionId: "temp-workspace-genesis",
      payload: {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Group",
        "name": "Coop Hive",
        "channels": [
          { "type": "Conversation", "id": "chan-gen", "name": "general" },
          { "type": "Conversation", "id": "chan-dev", "name": "development" }
        ],
        "members": [alice.id]
      }
    }, alice);

    const wsColAlice = new Collection(wsGenesis.id, workspaceReducer);
    await wsColAlice.addEvent(wsGenesis);

    // Export invite code representation
    const allWsEvents = Array.from(wsColAlice.events.values()).map(ev => ({
      header: ev.header,
      body: ev.body,
      signature: ev.signature,
      id: ev.id
    }));

    const channelBundles = [
      { id: "chan-gen", name: "general", events: [] },
      { id: "chan-dev", name: "development", events: [] }
    ];

    const invitePayload = {
      type: "WorkspaceInvite",
      id: wsColAlice.id,
      name: "Coop Hive",
      genesisEvent: allWsEvents.find(e => e.header.kind === "genesis"),
      events: allWsEvents.filter(e => e.header.kind !== "genesis"),
      channels: channelBundles
    };

    // Replicate / Import to Bob
    const payloadStr = JSON.stringify(invitePayload);
    const parsedPayload = JSON.parse(payloadStr);

    assert.strictEqual(parsedPayload.type, "WorkspaceInvite");
    assert.strictEqual(parsedPayload.name, "Coop Hive");
    assert.strictEqual(parsedPayload.channels.length, 2);

    // Bob creates collection from payload
    const bobWsGenesisData = parsedPayload.genesisEvent;
    const bobGenesis = new Event(bobWsGenesisData.header, bobWsGenesisData.body, bobWsGenesisData.signature, bobWsGenesisData.id);
    const wsColBob = new Collection(bobGenesis.id, workspaceReducer);
    await wsColBob.addEvent(bobGenesis);

    const bobWsState = await wsColBob.render();
    assert.strictEqual(bobWsState.name, "Coop Hive");
    assert.strictEqual(bobWsState.channels.length, 2);
    assert.strictEqual(bobWsState.channels[0].name, "general");
    assert.strictEqual(bobWsState.channels[1].name, "development");
    console.log("✓ Workspace Replication & Sync validation PASSED");

    // 9. Robust Base64 Decoder Verification
    console.log("\n9. Testing Robust Base64 Decoder...");
    
    // Test Case 1: Standard Base64 String
    const originalText = "Hello, WebOS Standards-Based Workspace!";
    const standardB64 = base64Encode(originalText);
    const decoded1 = base64Decode(standardB64);
    assert.strictEqual(decoded1, originalText, "Standard base64 decoding must succeed");

    // Test Case 2: Base64 String with whitespaces, tabs, newlines
    const messyB64 = `  \n  ${standardB64.slice(0, 10)} \n\r \t ${standardB64.slice(10)}  \n`;
    const decoded2 = base64Decode(messyB64);
    assert.strictEqual(decoded2, originalText, "Base64 decoding must strip all types of whitespace");

    // Test Case 3: Base64url characters (- and _)
    const urlSafeB64 = "eyJhIn0_eyJiIn0-"; // _ is /, - is +
    const decoded3 = base64Decode(urlSafeB64);
    assert.ok(decoded3, "Should decode base64url characters without throwing");

    // Test Case 4: Base64 with missing padding '='
    const unpaddedB64 = standardB64.replace(/=/g, "");
    const decoded4 = base64Decode(unpaddedB64);
    assert.strictEqual(decoded4, originalText, "Base64 decoding must restore missing padding");

    // Test Case 5: Full invite URL query param parsing
    const inviteLink = `https://afflom.github.io/holowhat/apps.html?invite=${standardB64}`;
    const decodedLink1 = base64Decode(inviteLink);
    assert.strictEqual(decodedLink1, originalText, "Base64 decoding must extract payload from 'invite' query parameter");

    // Test Case 6: Full invite URL with code parameter
    const inviteLinkCode = `https://afflom.github.io/holowhat/apps.html?code=${standardB64}`;
    const decodedLink2 = base64Decode(inviteLinkCode);
    assert.strictEqual(decodedLink2, originalText, "Base64 decoding must extract payload from 'code' query parameter");

    // Test Case 7: Full invite URL with hash payload
    const inviteLinkHash = `https://afflom.github.io/holowhat/apps.html#invite=${standardB64}`;
    const decodedLink3 = base64Decode(inviteLinkHash);
    assert.strictEqual(decodedLink3, originalText, "Base64 decoding must extract payload from hash parameters");

    // Test Case 8: Invalid base64 characters (e.g. %, @, etc.) that would make standard atob fail
    const invalidB64 = "!!!invalid-base64-character-values-%%%@@@";
    const decodedInvalid = base64Decode(invalidB64);
    assert.strictEqual(decodedInvalid, "", "Invalid base64 characters must decode to empty string without throwing");

    // Test Case 9: Non-JSON payload base64 string
    const nonJsonB64 = base64Encode("Not a JSON object");
    const decodedNonJson = base64Decode(nonJsonB64);
    assert.strictEqual(decodedNonJson, "Not a JSON object", "Non-JSON base64 string must decode cleanly");

    console.log("✓ Robust Base64 Decoder validation PASSED");

    // 10. StandardsValidator ESM Module Verification
    console.log("\n10. Testing StandardsValidator ESM Module (Node Mocked Fetch)...");
    await StandardsValidator.init("mocked-path://");
    assert.ok(StandardsValidator.asContext, "AS2 context should be loaded");
    assert.ok(StandardsValidator.schemaContext, "Schema.org context should be loaded");

    // Test validation of valid ActivityStreams Create activity
    StandardsValidator.validateActivityStreams({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "Create",
      "object": {
        "type": "Note",
        "content": "Valid text"
      }
    }, "Create");

    // Test validation of valid ActivityStreams OfferCall activity
    StandardsValidator.validateActivityStreams({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OfferCall",
      "callee": "mock-callee-id",
      "callStatus": "offered",
      "published": new Date().toISOString()
    }, "OfferCall");

    // Test validation failure on undefined context property
    try {
      StandardsValidator.validateActivityStreams({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Create",
        "invalidJargonPropertyField": "should fail validation check"
      }, "Create");
      assert.fail("Should throw on undefined activitystreams property");
    } catch (e) {
      assert.ok(e.message.includes("is not defined in the imported standards context"), "Should complain about undefined property in error message");
    }
    console.log("✓ StandardsValidator ESM validation PASSED");

    // 11. Peer Invitation, Secure Messaging, and Channel Reconciliation
    console.log("\n11. Testing Peer Invitation, Secure Messaging, and Channel Reconciliation...");
    
    // Alice and Bob key setups
    const aliceParticipant = await Participant.create();
    const bobParticipant = await Participant.create();
    
    // Alice creates channel genesis
    const aliceChanGenesis = await Event.create({
      kind: "genesis",
      author: aliceParticipant.id,
      collectionId: "temp-channel-p2p",
      payload: {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Conversation",
        "name": "p2p-chat",
        "published": new Date().toISOString()
      }
    }, aliceParticipant);
    
    const aliceChanCol = new Collection(aliceChanGenesis.id, messengerReducer);
    await aliceChanCol.addEvent(aliceChanGenesis);
    
    // Alice invites Bob: Alice creates a membership grant first
    const bobGrantEvent = await Event.create({
      kind: "membership",
      author: aliceParticipant.id,
      collectionId: aliceChanGenesis.id,
      parents: [aliceChanGenesis.id],
      clock: 1,
      payload: {
        target: bobParticipant.id,
        action: "grant",
        capabilities: ["read", "write"],
        curveId: bobParticipant.curveId
      }
    }, aliceParticipant);
    
    await aliceChanCol.addEvent(bobGrantEvent);
    
    // Alice generates a secret epoch key and wraps it for both herself and Bob
    const aliceSecretKey = await HoloAppsCrypto.generateEpochKey();
    const aliceWrappedForSelf = await HoloAppsCrypto.wrapEpochKey(aliceSecretKey, aliceParticipant.curveKeys.privateKey, aliceParticipant.curveId);
    const aliceWrappedForBob = await HoloAppsCrypto.wrapEpochKey(aliceSecretKey, aliceParticipant.curveKeys.privateKey, bobParticipant.curveId);
    
    const keyRotationEvent = await Event.create({
      kind: "epoch",
      author: aliceParticipant.id,
      collectionId: aliceChanGenesis.id,
      parents: [bobGrantEvent.id],
      clock: 2,
      payload: {
        senderCurveId: aliceParticipant.curveId,
        wrappedKeys: {
          [aliceParticipant.id]: aliceWrappedForSelf,
          [bobParticipant.id]: aliceWrappedForBob
        }
      }
    }, aliceParticipant);
    
    await aliceChanCol.addEvent(keyRotationEvent);
    await aliceChanCol.unwrapAndStoreEpochKey(keyRotationEvent, aliceParticipant);
    
    // Alice writes message 1 (encrypted) under the new keyRotationEvent epoch
    const aliceMsg1 = await Event.create({
      kind: "message",
      author: aliceParticipant.id,
      collectionId: aliceChanGenesis.id,
      parents: [keyRotationEvent.id],
      epochId: keyRotationEvent.id,
      clock: 3,
      payload: {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Create",
        "object": {
          "type": "Note",
          "content": "Secret handshake from Alice"
        }
      }
    }, aliceParticipant, aliceSecretKey);
    
    await aliceChanCol.addEvent(aliceMsg1);
    
    // Export invite payload from Alice's side
    const aliceAllEvents = Array.from(aliceChanCol.events.values()).map(ev => ({
      header: ev.header,
      body: ev.body,
      signature: ev.signature,
      id: ev.id
    }));
    
    const inviteObj = {
      id: aliceChanCol.id,
      name: "p2p-chat",
      genesisEvent: aliceAllEvents.find(e => e.header.kind === "genesis"),
      events: aliceAllEvents.filter(e => e.header.kind !== "genesis")
    };
    
    const inviteCodeString = base64Encode(JSON.stringify(inviteObj));
    
    // --- BOB JOINS ---
    const bobPayload = JSON.parse(base64Decode(inviteCodeString));
    assert.strictEqual(bobPayload.id, aliceChanCol.id);
    
    const bobP2PGenesisData = bobPayload.genesisEvent;
    const bobP2PGenesis = new Event(bobP2PGenesisData.header, bobP2PGenesisData.body, bobP2PGenesisData.signature, bobP2PGenesisData.id);
    
    const bobChanCol = new Collection(bobP2PGenesis.id, messengerReducer);
    await bobChanCol.addEvent(bobP2PGenesis);
    
    for (const evData of bobPayload.events) {
      const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
      await bobChanCol.addEvent(ev);
    }
    
    // Bob unwraps epoch keys to read channel history
    for (const ev of bobChanCol.events.values()) {
      if (ev.header.kind === "epoch") {
        await bobChanCol.unwrapAndStoreEpochKey(ev, bobParticipant);
      }
    }
    
    // Bob renders the view and verifies Alice's message is decrypted
    const bobView = await bobChanCol.render();
    assert.strictEqual(bobView.messages.length, 1);
    assert.strictEqual(bobView.messages[0].body, "Secret handshake from Alice");
    
    // Bob replies back to Alice
    const bobReply = await Event.create({
      kind: "message",
      author: bobParticipant.id,
      collectionId: bobChanCol.id,
      parents: Array.from(bobChanCol.heads),
      epochId: keyRotationEvent.id,
      clock: 4,
      payload: {
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Create",
        "object": {
          "type": "Note",
          "content": "Bob is in! Hello Alice!"
        }
      }
    }, bobParticipant, aliceSecretKey); // uses same decrypted epoch key
    
    await bobChanCol.addEvent(bobReply);
    
    // Bob exports his new state to Alice
    const bobAllEvents = Array.from(bobChanCol.events.values()).map(ev => ({
      header: ev.header,
      body: ev.body,
      signature: ev.signature,
      id: ev.id
    }));
    
    // Alice reconciles Bob's events
    for (const evData of bobAllEvents) {
      const ev = new Event(evData.header, evData.body, evData.signature, evData.id);
      await aliceChanCol.addEvent(ev);
    }
    
    // Alice renders the view and verifies Bob's reply is visible
    const aliceView = await aliceChanCol.render();
    assert.strictEqual(aliceView.messages.length, 2);
    assert.strictEqual(aliceView.messages[1].body, "Bob is in! Hello Alice!");
    console.log("✓ Peer Invitation, Secure Messaging, and Channel Reconciliation PASSED");

    console.log("\n==============================================");
    console.log("🎉 ALL holo-apps Architecture Validation Tests PASSED!");
    console.log("==============================================");
    process.exitCode = 0;
  } catch (error) {
    console.error("\n❌ Validation test suite FAILED:", error);
    process.exitCode = 1;
  }
}

runTests();
