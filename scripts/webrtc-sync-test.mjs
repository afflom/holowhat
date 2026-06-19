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

const PORT = 8001;
server.listen(PORT, async () => {
  console.log(`WebRTC test server running at http://localhost:${PORT}`);
  
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    // Create 2 contexts to avoid shared session storage/cookies (separate peers)
    const contextAlice = await browser.newContext();
    const contextBob = await browser.newContext();
    
    const alicePage = await contextAlice.newPage();
    const bobPage = await contextBob.newPage();
    
    alicePage.on("console", msg => console.log(`ALICE BROWSER:`, msg.text()));
    bobPage.on("console", msg => console.log(`BOB BROWSER:`, msg.text()));

    // 1. Go to login pages
    console.log("Navigating Alice to login...");
    await alicePage.goto(`http://localhost:${PORT}/login.html`, { waitUntil: "networkidle" });
    
    console.log("Navigating Bob to login...");
    await bobPage.goto(`http://localhost:${PORT}/login.html`, { waitUntil: "networkidle" });

    // 2. Continue local-first to enter the world selection
    console.log("Entering World Selector on both pages...");
    const aliceStart = alicePage.locator("button.nav-login-button").first();
    await aliceStart.waitFor({ timeout: 25000 });
    await aliceStart.click();
    const aliceLocal = alicePage.locator("button.local-btn");
    await aliceLocal.waitFor({ timeout: 15000 });
    await aliceLocal.click();
    await alicePage.waitForURL("**/worlds.html", { timeout: 15000 });

    const bobStart = bobPage.locator("button.nav-login-button").first();
    await bobStart.waitFor({ timeout: 25000 });
    await bobStart.click();
    const bobLocal = bobPage.locator("button.local-btn");
    await bobLocal.waitFor({ timeout: 15000 });
    await bobLocal.click();
    await bobPage.waitForURL("**/worlds.html", { timeout: 15000 });

    // 3. Alice creates a World
    console.log("Alice creating a world...");
    await alicePage.locator("button", { hasText: "Create a World" }).click();
    const aliceWorldCard = alicePage.locator(".world").nth(1);
    await aliceWorldCard.waitFor({ timeout: 10000 });
    await aliceWorldCard.click();
    await alicePage.waitForURL("**/playground.html?id=*", { timeout: 15000 });
    const worldUrl = alicePage.url();
    console.log("Alice created world canvas:", worldUrl);

    // 4. Bob joins the exact same World by navigating to Alice's world URL
    console.log("Bob navigating to Alice's world URL...");
    await bobPage.goto(worldUrl, { waitUntil: "networkidle" });
    await bobPage.waitForURL("**/playground.html?id=*", { timeout: 15000 });
    console.log("Bob joined world canvas:", bobPage.url());

    // Wait for Alice's world component to load (already stored locally)
    await alicePage.locator("world-block >> .world").waitFor({ timeout: 10000 });

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

    // 6. Gather and exchange ICE candidates
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

    // 7. Verify WebRTC data channel transitions to Open state
    console.log("Waiting for WebRTC data channel to open...");
    let connected = false;
    for (let i = 0; i < 20; i++) {
      connected = await alicePage.evaluate(() => window.cnLink.is_open());
      if (connected) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    assert.ok(connected, "WebRTC Data Channel must successfully open between Alice and Bob!");
    console.log("✓ WebRTC connection established successfully!");

    // 8. Verify Bob receives and renders the replicated world document over WebRTC
    console.log("Waiting for Bob's replicated world component to load...");
    await bobPage.locator("world-block >> .world").waitFor({ timeout: 15000 });
    console.log("✓ Bob successfully replicated and rendered the world document!");

    console.log("decentralization E2E WebRTC sync test PASSED successfully!");
    process.exitCode = 0;
  } catch (error) {
    console.error("decentralization E2E WebRTC sync test FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    server.close();
  }
});
