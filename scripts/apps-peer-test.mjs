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
    
    alicePage.on("console", msg => console.log(`ALICE BROWSER:`, msg.text()));
    bobPage.on("console", msg => console.log(`BOB BROWSER:`, msg.text()));

    const aliceErrors = [];
    const bobErrors = [];
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

    // 6. Alice selects `# general` channel and starts chat
    console.log("Alice selecting general channel...");
    await alicePage.locator(".sidebar-item:has-text('# general')").click();
    await alicePage.locator("input.chat-input").waitFor({ timeout: 5000 });

    // 7. Alice invites Bob to the channel to grant him write caps and rotate epoch key
    let channelInviteCode = "";
    alicePage.removeAllListeners("dialog");
    alicePage.on("dialog", async dialog => {
      const message = dialog.message();
      const type = dialog.type();
      console.log(`[Alice Dialog] message: ${message}`);
      if (type === "prompt") {
        if (message.includes("Select a contact to invite")) {
          await dialog.accept("new");
        } else if (message.includes("Enter Invitee's Identity Address")) {
          await dialog.accept(bobId);
        } else if (message.includes("Enter Invitee's ECDH Public Exchange Key")) {
          await dialog.accept(bobCurveId);
        } else if (message.includes("Share this Invite Code")) {
          channelInviteCode = dialog.defaultValue();
          await dialog.accept(channelInviteCode);
        } else {
          await dialog.accept();
        }
      } else {
        await dialog.accept();
      }
    });

    console.log("Alice inviting Bob to channel general...");
    await alicePage.locator("button:has-text('Invite Peer')").click();
    for (let i = 0; i < 50; i++) {
      if (channelInviteCode) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(channelInviteCode, "Channel invite code must be generated");

    // 8. Bob selects the general channel to listen for messages
    console.log("Bob selecting general channel...");
    await bobPage.locator(".sidebar-item:has-text('# general')").click();
    await bobPage.locator("input.chat-input").waitFor({ timeout: 5000 });

    // 9. Alice types and sends a secure message
    console.log("Alice sending secure message...");
    await alicePage.locator("input.chat-input").fill("Hello Bob, secure channel active!");
    await alicePage.locator("button.send-btn").first().click();

    // Wait for it to render in Alice's timeline
    await alicePage.locator(".message-body-text:has-text('Hello Bob, secure channel active!')").waitFor({ timeout: 10000 });

    // 10. Verify Bob automatically decrypts and reads Alice's message via WebRTC sync!
    console.log("Bob waiting for Alice's decrypted message in timeline...");
    const bobMsgText = bobPage.locator(".message-body-text:has-text('Hello Bob, secure channel active!')");
    await bobMsgText.waitFor({ timeout: 15000 });
    console.log("✓ Bob successfully decrypted and read Alice's message!");

    // 11. Bob writes a reply message
    console.log("Bob replying to Alice...");
    await bobPage.locator("input.chat-input").fill("Hi Alice, verified decrypted!");
    await bobPage.locator("button.send-btn").first().click();

    // Wait for it to render in Bob's timeline
    await bobPage.locator(".message-body-text:has-text('Hi Alice, verified decrypted!')").waitFor({ timeout: 10000 });

    // 12. Verify Alice automatically decrypts and reads Bob's reply via WebRTC sync!
    console.log("Alice waiting for Bob's decrypted reply in timeline...");
    const aliceReplyText = alicePage.locator(".message-body-text:has-text('Hi Alice, verified decrypted!')");
    await aliceReplyText.waitFor({ timeout: 15000 });
    console.log("✓ Alice successfully decrypted and read Bob's reply!");

    // Check for any console exceptions
    if (aliceErrors.length > 0) {
      throw new Error(`Alice page errors: ${aliceErrors.map(e => e.message).join(", ")}`);
    }
    if (bobErrors.length > 0) {
      throw new Error(`Bob page errors: ${bobErrors.map(e => e.message).join(", ")}`);
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
