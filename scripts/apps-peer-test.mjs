import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, "../_site");

const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  let filePath = path.join(SITE_DIR, req.url.split("?")[0]);
  if (req.url === "/" || req.url.startsWith("/?")) {
    filePath = path.join(SITE_DIR, "index.html");
  }

  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    if (filePath.includes("worlds")) {
      filePath = path.join(SITE_DIR, "worlds.html");
    } else if (filePath.includes("login")) {
      filePath = path.join(SITE_DIR, "login.html");
    } else {
      filePath = path.join(SITE_DIR, "index.html");
    }
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
    } else {
      const ext = path.extname(filePath);
      const mime = mimeTypes[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
    }
  });
});

const PORT = 8002;
server.listen(PORT, async () => {
  console.log(`P2P Sync test server running at http://localhost:${PORT}`);
  
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
    
    // Create 2 contexts to avoid shared session storage/cookies (separate peers)
    const contextAlice = await browser.newContext();
    const contextBob = await browser.newContext();
    
    const alicePage = await contextAlice.newPage();
    const bobPage = await contextBob.newPage();
    
    const aliceErrors = [];
    const aliceWarnings = [];
    const bobErrors = [];
    const bobWarnings = [];

    alicePage.on("console", msg => {
      const type = msg.type();
      const text = msg.text();
      console.log(`ALICE BROWSER [${type}]:`, text);
      if (type === "error") {
        aliceErrors.push(new Error(`Console error: ${text}`));
      } else if (type === "warning") {
        aliceWarnings.push(new Error(`Console warning: ${text}`));
      }
    });

    bobPage.on("console", msg => {
      const type = msg.type();
      const text = msg.text();
      console.log(`BOB BROWSER [${type}]:`, text);
      if (type === "error") {
        bobErrors.push(new Error(`Console error: ${text}`));
      } else if (type === "warning") {
        bobWarnings.push(new Error(`Console warning: ${text}`));
      }
    });

    alicePage.on("pageerror", err => {
      console.error("ALICE BROWSER ERROR:", err.message);
      aliceErrors.push(err);
    });
    bobPage.on("pageerror", err => {
      console.error("BOB BROWSER ERROR:", err.message);
      bobErrors.push(err);
    });

    // 1. Navigate to apps page
    console.log("Navigating Alice and Bob to apps.html...");
    await alicePage.goto(`http://localhost:${PORT}/apps.html`, { waitUntil: "networkidle" });
    await bobPage.goto(`http://localhost:${PORT}/apps.html`, { waitUntil: "networkidle" });

    // 2. Sign-in on both pages
    console.log("Signing in (creating profiles)...");
    const aliceCreateBtn = alicePage.locator("button:has-text('Create New User Profile')");
    await aliceCreateBtn.waitFor({ timeout: 10000 });
    await aliceCreateBtn.click();

    const bobCreateBtn = bobPage.locator("button:has-text('Create New User Profile')");
    await bobCreateBtn.waitFor({ timeout: 10000 });
    await bobCreateBtn.click();

    // Wait for the overlay to disappear
    await alicePage.locator("h3:has-text('User Account & Security')").waitFor({ timeout: 10000 });
    await bobPage.locator("h3:has-text('User Account & Security')").waitFor({ timeout: 10000 });
    console.log("✓ Profiles created successfully");

    // Retrieve Bob and Alice's IDs programmatically to use in invitation prompts
    const bobId = await bobPage.evaluate(() => Alpine.$data(document.body).participant.id);
    const bobCurveId = await bobPage.evaluate(() => Alpine.$data(document.body).participant.curveId);
    console.log(`Bob ID: ${bobId.substring(0, 16)}...`);
    console.log(`Bob Curve ID: ${bobCurveId.substring(0, 16)}...`);

    const aliceId = await alicePage.evaluate(() => Alpine.$data(document.body).participant.id);
    const aliceCurveId = await alicePage.evaluate(() => Alpine.$data(document.body).participant.curveId);
    console.log(`Alice ID: ${aliceId.substring(0, 16)}...`);
    console.log(`Alice Curve ID: ${aliceCurveId.substring(0, 16)}...`);

    // 3. Alice creates a workspace
    console.log("Alice creating workspace 'Swarm Workspace'...");
    await alicePage.locator("button:has-text('+ Create WS')").click();
    await alicePage.locator("input[placeholder='Workspace Name']").fill("Swarm Workspace");
    await alicePage.locator(".dialog:has(h2:has-text('Create New Workspace')) button:text-is('Create')").click();
    
    // Verify it is created in Alice's sidebar
    await alicePage.locator(".sidebar-item:has-text('Swarm Workspace')").waitFor({ timeout: 10000 });
    console.log("✓ Workspace created on Alice's side");

    // 4. Alice exports workspace invite code
    let aliceInviteCode = "";
    alicePage.on("dialog", async dialog => {
      const message = dialog.message();
      console.log(`[Alice Dialog] message: ${message}`);
      if (dialog.type() === "prompt" && message.includes("Share this Workspace Invite Code")) {
        aliceInviteCode = dialog.defaultValue();
        await dialog.accept(aliceInviteCode);
      } else {
        await dialog.accept();
      }
    });

    console.log("Alice generating workspace invite code...");
    await alicePage.locator("button:has-text('Generate Workspace Invite Link/Code')").click();
    assert.ok(aliceInviteCode, "Workspace invite code must be generated");

    // 5. Bob joins the workspace
    console.log("Bob joining Alice's workspace...");
    bobPage.on("dialog", async dialog => {
      console.log(`[Bob Dialog] message: ${dialog.message()}`);
      await dialog.accept();
    });

    await bobPage.locator("button:has-text('→ Join WS')").click();
    await bobPage.locator("input[placeholder='Paste Workspace Invite Code']").fill(aliceInviteCode);
    await bobPage.locator(".dialog:has(h2:has-text('Join Workspace')) button:text-is('Join')").click();

    // Verify workspace appears in Bob's sidebar
    await bobPage.locator(".sidebar-item:has-text('Swarm Workspace')").waitFor({ timeout: 10000 });
    console.log("✓ Bob successfully joined the workspace");

    // 5. Establish peer-to-peer WebRTC link signaling programmatically
    console.log("Establishing WebRTC connection...");
    
    // Alice generates SDP offer
    const offerSdp = await alicePage.evaluate(async () => {
      return await window.connectPeerLink(true);
    });
    assert.ok(offerSdp, "Alice should successfully generate SDP offer");

    // Bob accepts offer and generates SDP answer
    const answerSdp = await bobPage.evaluate(async (sdp) => {
      return await window.connectPeerLink(false, sdp);
    }, offerSdp);
    assert.ok(answerSdp, "Bob should successfully generate SDP answer");

    // Alice accepts SDP answer
    await alicePage.evaluate(async (sdp) => {
      await window.acceptPeerAnswer(sdp);
    }, answerSdp);

    // Gather and exchange ICE candidates
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const aliceIce = await alicePage.evaluate(() => window.cnLink.take_ice());
    const bobIce = await bobPage.evaluate(() => window.cnLink.take_ice());

    console.log(`Exchanging ICE candidates (Alice: ${aliceIce.length}, Bob: ${bobIce.length})...`);
    
    for (const ice of aliceIce) {
      await bobPage.evaluate(async (cand) => {
        await window.cnLink.add_ice(cand);
      }, ice);
    }
    for (const ice of bobIce) {
      await alicePage.evaluate(async (cand) => {
        await window.cnLink.add_ice(cand);
      }, ice);
    }

    // Verify WebRTC data channel transitions to Open state
    console.log("Waiting for WebRTC data channel to open...");
    let connected = false;
    for (let i = 0; i < 20; i++) {
      connected = await alicePage.evaluate(() => window.cnLink.is_open());
      if (connected) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    assert.ok(connected, "WebRTC Data Channel must successfully open between Alice and Bob!");
    console.log("✓ WebRTC connection established successfully!");

    // 6. Alice adds Bob to the workspace
    console.log("Alice adding Bob to the workspace...");
    alicePage.removeAllListeners("dialog");
    alicePage.on("dialog", async dialog => {
      const message = dialog.message();
      console.log(`[Alice Dialog] prompt for member: ${message}`);
      if (dialog.type() === "prompt" && message.includes("Enter Member's Account ID")) {
        await dialog.accept(bobId);
      } else {
        await dialog.accept();
      }
    });
    await alicePage.locator("button:has-text('+ Member')").click();
    
    // Wait for Bob to sync and receive the add-member event
    console.log("Waiting for Bob's workspace state to sync...");
    await new Promise(r => setTimeout(r, 3000));

    // 7. Bob selects `# general` and sends a message directly (using inherited workspace capabilities!)
    console.log("Bob selecting general channel...");
    await bobPage.locator(".sidebar-item:has-text('# general')").click();
    await bobPage.locator("input.chat-input").waitFor({ timeout: 5000 });

    console.log("Bob sending message to general...");
    await bobPage.locator("input.chat-input").fill("Hi Alice, writing directly via workspace permissions!");
    await bobPage.locator("button.send-btn").first().click();

    // Wait for it to render in Alice's timeline
    console.log("Alice waiting for Bob's message in timeline...");
    await alicePage.locator(".sidebar-item:has-text('# general')").click();
    await alicePage.locator(".message-body-text:has-text('Hi Alice, writing directly via workspace permissions!')").waitFor({ timeout: 15000 });
    console.log("✓ Bob successfully wrote directly to general channel!");

    // 8. Alice promotes Bob to Workspace Admin
    console.log("Alice promoting Bob to Workspace Admin...");
    alicePage.removeAllListeners("dialog");
    alicePage.on("dialog", async dialog => {
      await dialog.accept();
    });
    await alicePage.locator(".sidebar-item:has-text('Workspace Dashboard')").click();
    await alicePage.locator("button:has-text('Promote')").click();
    
    console.log("Waiting for Bob to sync admin status...");
    await new Promise(r => setTimeout(r, 3000));

    // 9. Bob creates a new channel '# custom-workspace-chan'
    console.log("Bob creating new channel '# custom-workspace-chan'...");
    await bobPage.locator("button:has-text('+ Channel')").click();
    const chanNameInput = bobPage.locator("input[placeholder='Channel Name']");
    await chanNameInput.waitFor({ timeout: 5000 });
    await chanNameInput.fill("custom-workspace-chan");
    await bobPage.locator(".dialog:has(h2:has-text('Create New Channel')) button:text-is('Create')").click();
    await bobPage.locator(".sidebar-item:has-text('# custom-workspace-chan')").waitFor({ timeout: 10000 });
    console.log("✓ Channel custom-workspace-chan created on Bob's side");

    // 10. Alice verifies and selects the new channel in real-time
    console.log("Alice waiting for new channel to appear in sidebar...");
    await alicePage.locator(".sidebar-item:has-text('# custom-workspace-chan')").waitFor({ timeout: 15000 });
    await alicePage.locator(".sidebar-item:has-text('# custom-workspace-chan')").click();
    await alicePage.locator("input.chat-input").waitFor({ timeout: 5000 });
    console.log("✓ Alice successfully discovered and selected the new channel in real-time!");

    // 11. Alice sends a message in the custom channel
    console.log("Alice sending message in custom channel...");
    await alicePage.locator("input.chat-input").fill("Hello Bob, this new channel synced perfectly!");
    await alicePage.locator("button.send-btn").first().click();

    // Bob receives it in real-time!
    console.log("Bob selecting custom channel...");
    await bobPage.locator(".sidebar-item:has-text('# custom-workspace-chan')").click();
    await bobPage.locator("input.chat-input").waitFor({ timeout: 5000 });

    console.log("Bob waiting for Alice's message in custom channel...");
    try {
      await bobPage.locator(".message-body-text:has-text('Hello Bob, this new channel synced perfectly!')").waitFor({ timeout: 5000 });
    } catch (e) {
      console.log("TIMEOUT ERROR - DUMPING BOB STORAGE AND STATE");
      const storage = await bobPage.evaluate(() => {
        const colEventsDumps = {};
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("holoapps_col_events:")) {
            colEventsDumps[k] = localStorage.getItem(k);
          }
        }
        
        let activeChanDump = null;
        const bodyEl = document.querySelector("body");
        if (bodyEl && typeof Alpine !== "undefined") {
          const shell = Alpine.$data(bodyEl);
          if (shell.activeChannel) {
            activeChanDump = {
              id: shell.activeChannel.id,
              name: shell.activeChannel.name,
              hasCollection: !!shell.activeChannel.collection,
              eventsInCol: shell.activeChannel.collection ? Array.from(shell.activeChannel.collection.events.values()).map(ev => ({
                id: ev.id,
                kind: ev.header.kind,
                parents: ev.header.parents,
                author: ev.header.author
              })) : null,
              membersInCol: shell.activeChannel.collection ? Array.from(shell.activeChannel.collection.members.keys()) : null,
              capsInCol: shell.activeChannel.collection ? Array.from(shell.activeChannel.collection.capabilities.entries()) : null
            };
          }
        }
        return {
          keys: Object.keys(localStorage),
          colEventsDumps,
          activeChannel: activeChanDump
        };
      });
      console.log("BOB DUMP:", JSON.stringify(storage, null, 2));
      throw e;
    }
    console.log("✓ Bob successfully received Alice's message in the new channel!");

    // Check for any console exceptions or warnings
    if (aliceErrors.length > 0) {
      throw new Error(`Alice page errors: ${aliceErrors.map(e => e.message).join(", ")}`);
    }
    if (aliceWarnings.length > 0) {
      throw new Error(`Alice page warnings: ${aliceWarnings.map(e => e.message).join(", ")}`);
    }
    if (bobErrors.length > 0) {
      throw new Error(`Bob page errors: ${bobErrors.map(e => e.message).join(", ")}`);
    }
    if (bobWarnings.length > 0) {
      throw new Error(`Bob page warnings: ${bobWarnings.map(e => e.message).join(", ")}`);
    }

    console.log("🎉 Holo-Apps Peer Synchronization & Secure Messaging E2E test PASSED successfully!");
    process.exitCode = 0;
  } catch (error) {
    console.error("Holo-Apps Peer Synchronization & Secure Messaging E2E test FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    server.close();
  }
});
