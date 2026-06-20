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

const PORT = 8003;
server.listen(PORT, async () => {
  console.log(`Behavioral UX test server running at http://localhost:${PORT}`);
  
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
    
    const context = await browser.newContext();
    const page = await context.newPage();
    
    const pageErrors = [];
    page.on("pageerror", err => {
      console.error("BROWSER ERROR:", err.message);
      pageErrors.push(err);
    });

    console.log("Navigating to apps.html...");
    await page.goto(`http://localhost:${PORT}/apps.html`, { waitUntil: "networkidle" });

    // 1. Check default Nickname
    const nicknameVal = await page.locator("input[placeholder='Display Nickname (e.g. Alice)']").inputValue();
    assert.strictEqual(nicknameVal, "Operator", "Default nickname should be 'Operator'");
    console.log("✓ Default nickname input verified");

    // 2. Click profile creation button
    console.log("Creating new profile...");
    await page.locator("button:has-text('Create New User Profile')").click();
    await page.locator("h3:has-text('User Account & Security')").waitFor({ timeout: 5000 });

    // 3. Verify user card display and Holo ID formatting
    const isUserCardVisible = await page.locator(".user-id-card").isVisible();
    assert.ok(isUserCardVisible, "User ID card must be visible on the dashboard");
    console.log("✓ User ID card visibility verified");

    const holoId = await page.evaluate(() => {
      const shell = window.shellInstance;
      return shell.getHoloId();
    });
    console.log("Generated Holo ID:", holoId);
    assert.ok(holoId.startsWith("@Operator:"), "Holo ID must start with @Operator:");
    console.log("✓ Holo ID serialization verified");

    // 4. Test parsing of Holo ID
    const parsed = await page.evaluate((idStr) => {
      const shell = window.shellInstance;
      return shell.parseHoloId(idStr);
    }, holoId);
    console.log("Parsed Holo ID:", parsed);
    assert.strictEqual(parsed.name, "Operator", "Parsed nickname must match Operator");
    assert.ok(parsed.id, "Parsed signature ID must exist");
    assert.ok(parsed.curveId, "Parsed Curve ID must exist");
    console.log("✓ Holo ID parser verified");

    // 5. Verify procedural avatar SVG generation
    const avatarInnerHtml = await page.evaluate(() => {
      const shell = window.shellInstance;
      return shell.generateAvatarSvg(shell.participant.id);
    });
    assert.ok(avatarInnerHtml.includes("<rect"), "Avatar SVG must contain background rect");
    assert.ok(avatarInnerHtml.includes("linearGradient"), "Avatar SVG must contain linearGradient definition");
    console.log("✓ Procedural avatar SVG generation verified");

    // 6. Test visual workspace pass validation
    const passCode = "eyJ0eXBlIjoiV29ya3NwYWNlSW52aXRlIiwiaWQiOiJ0ZXN0LXdzLWlkIiwibmFtZSI6IkJlaGF2aW9yYWwgVGVzdCBXb3JrIiwiZ2VuZXNpc0V2ZW50Ijp7ImhlYWRlciI6eyJhdXRob3IiOiJteS1hdXRob3Ita2V5In19fQ==";
    
    // Test valid pass
    const validPreview = await page.evaluate((code) => {
      const shell = window.shellInstance;
      shell.validateAndPreviewPass(code);
      return shell.passPreview;
    }, passCode);
    console.log("Valid Pass Preview result:", validPreview);
    assert.ok(validPreview, "Preview should be populated for valid pass");
    assert.strictEqual(validPreview.name, "Behavioral Test Work", "Preview name should match invite payload name");
    assert.strictEqual(validPreview.creator, "my-author-key...", "Preview creator DID key should be trimmed author");

    // Test invalid pass
    const invalidPreview = await page.evaluate(() => {
      const shell = window.shellInstance;
      shell.validateAndPreviewPass("invalid-base-64-string!");
      return shell.passPreview;
    }, passCode);
    assert.strictEqual(invalidPreview, null, "Preview should be null for invalid pass");
    console.log("✓ Visual workspace pass validation states verified");

    // 7. Verify online discovery addition
    const dummyPeer = {
      id: "another-pub-key-hash-1234567890",
      curveId: "another-curve-key-hash-0987654321",
      name: "NearbyBob"
    };
    
    await page.evaluate((peer) => {
      const shell = window.shellInstance;
      shell.discoveredPeers.push(peer);
    }, dummyPeer);

    const initialPeerCount = await page.evaluate(() => window.shellInstance.discoveredPeers.length);
    assert.strictEqual(initialPeerCount, 1, "Discovered peers list should have 1 peer");

    // Add contact via discovered swarm peer click
    await page.evaluate((peer) => {
      const shell = window.shellInstance;
      shell.addDiscoveredContact(peer);
    }, dummyPeer);

    const contactExists = await page.evaluate((peer) => {
      return !!window.shellInstance.contacts.find(c => c.id === peer.id);
    }, dummyPeer);
    assert.ok(contactExists, "Bob should be added to contacts after clicking add contact");
    
    const postPeerCount = await page.evaluate(() => window.shellInstance.discoveredPeers.length);
    assert.strictEqual(postPeerCount, 0, "Discovered list should be cleared of the added peer");
    console.log("✓ Discovered online swarm peer addition verified");

    if (pageErrors.length > 0) {
      throw new Error(`Page console errors during run: ${pageErrors.map(e => e.message).join(", ")}`);
    }

    console.log("🎉 Behavioral HCD UX test PASSED successfully!");
    process.exitCode = 0;
  } catch (error) {
    console.error("Behavioral HCD UX test FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    server.close();
  }
});
