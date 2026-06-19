import { Participant, Event, Collection, App, AppIndex, Shell, canonicalJson, sha256, HoloAppsCrypto } from "../crates/holospaces-web/web/assets/scripts/holo-apps.js";
import { messengerReducer, createMessengerApp } from "../crates/holospaces-web/web/assets/scripts/holo-messenger.js";
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

async function runTests() {
  console.log("==============================================");
  console.log("🧪 Running holo-apps Architecture Validation Suite...");
  console.log("==============================================");

  try {
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
    console.log("✓ Messenger Reducer validation PASSED");

    // 7. W3C ActivityStreams 2.0 & Schema.org Conformance Test
    console.log("\n7. Testing W3C ActivityStreams 2.0 & Schema.org Standards Conformance...");
    
    // Import external validation artifacts (standards contexts)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    const asContextPath = path.join(__dirname, "activitystreams-context.json");
    const schemaContextPath = path.join(__dirname, "schema-org-context.json");

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
