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

    // 8. Verify Opt-in Discoverability & Swarm Announcements
    const discoverableInit = await page.evaluate(() => {
      const shell = window.shellInstance;
      const initial = shell.isDiscoverable;
      shell.toggleDiscoverable();
      const afterToggle = shell.isDiscoverable;
      shell.toggleDiscoverable(); // Restore
      return { initial, afterToggle, restored: shell.isDiscoverable };
    });
    assert.strictEqual(discoverableInit.initial, true, "isDiscoverable should default to true");
    assert.strictEqual(discoverableInit.afterToggle, false, "isDiscoverable should toggle to false");
    assert.strictEqual(discoverableInit.restored, true, "isDiscoverable should restore to true");
    console.log("✓ Opt-in Discoverability state toggling verified");

    // 9. Verify Friend Request & Approval Workflow
    const requestWorkflow = await page.evaluate(async () => {
      const shell = window.shellInstance;
      // Simulate incoming friend request
      shell.friendRequests.push({
        senderId: "mock-alice-id-123456",
        senderName: "AliceMock",
        senderCurveId: "mock-alice-curve-123456"
      });
      const initialCount = shell.friendRequests.length;
      await shell.acceptFriendRequest(shell.friendRequests[0]);
      const postAcceptCount = shell.friendRequests.length;
      const isContactAdded = !!shell.contacts.find(c => c.id === "mock-alice-id-123456");
      return { initialCount, postAcceptCount, isContactAdded };
    });
    assert.strictEqual(requestWorkflow.initialCount, 1, "Friend requests array should have 1 item initially");
    assert.strictEqual(requestWorkflow.postAcceptCount, 0, "Friend requests array should be cleared after acceptance");
    assert.ok(requestWorkflow.isContactAdded, "AliceMock should be added to contacts after request approval");
    console.log("✓ Friend Request / Approval workflow execution verified");

    // 10. Verify well-organized media library and privacy filters
    const mediaPrivacyCheck = await page.evaluate(() => {
      const shell = window.shellInstance;
      const col = shell.activeWorkspace.collection;
      
      // Inject standard media item events directly into the workspace collection
      col.events.set("media-pub-1", {
        id: "media-pub-1",
        header: { kind: "media-item", author: "other-user" },
        body: {
          cleartext: {
            title: "Public Doc",
            url: "http://example.com",
            mediaType: "application/pdf",
            privacy: "public",
            summary: "Public document summary"
          }
        }
      });
      
      col.events.set("media-priv-2", {
        id: "media-priv-2",
        header: { kind: "media-item", author: "other-user" },
        body: {
          cleartext: {
            title: "Private Doc",
            url: "http://example.com",
            mediaType: "application/pdf",
            privacy: "private",
            summary: "Private document summary"
          }
        }
      });

      const visible = shell.filteredWorkspaceMedia;
      const pubVisible = !!visible.find(m => m.id === "media-pub-1");
      const privVisible = !!visible.find(m => m.id === "media-priv-2");
      return {
        pubVisible,
        privVisible,
        workspaceMediaItems: shell.workspaceMediaItems,
        filteredWorkspaceMedia: visible,
        activeWorkspace: shell.activeWorkspace,
        participantId: shell.participant ? shell.participant.id : ""
      };
    });
    assert.ok(mediaPrivacyCheck.pubVisible, "Public media item should be visible to other operators");
    assert.strictEqual(mediaPrivacyCheck.privVisible, false, "Private media item should be filtered out from other operators");
    console.log("✓ Media Library privacy filtering scopes verified");

    // 11. Verify Holo-Apps Registry & Launch Userland App
    const appRegistryCheck = await page.evaluate(async () => {
      const shell = window.shellInstance;
      const col = shell.activeWorkspace.collection;
      
      col.events.set("app-bundle-123", {
        id: "app-bundle-123",
        header: { kind: "media-item", author: "other-user" },
        body: {
          cleartext: {
            title: "Custom Wiki",
            url: "http://app.com",
            mediaType: "application/x-holo-app",
            privacy: "public",
            summary: "Custom wiki description"
          }
        }
      });
      
      const sharedApps = shell.workspaceSharedApps;
      const hasSharedApp = !!sharedApps.find(a => a.id === "app-bundle-123");
      
      await shell.launchUserlandApp(sharedApps.find(a => a.id === "app-bundle-123"));
      const isLaunched = shell.activeRunningApp && shell.activeRunningApp.id === "app-bundle-123";
      return { hasSharedApp, isLaunched };
    });
    assert.ok(appRegistryCheck.hasSharedApp, "Shared holo-apps registry should expose workspace app bundle");
    assert.ok(appRegistryCheck.isLaunched, "Userland app launcher should activate running app sandbox state");
    console.log("✓ Holo-Apps registry catalog and userland launching verified");

    // 12. Verify Chat Dynamic Content Linking
    const chatContentLinking = await page.evaluate(async () => {
      const shell = window.shellInstance;
      const ch = shell.channels[0];
      if (ch) {
        await shell.selectChannel(ch);
        await new Promise(r => setTimeout(r, 150));
        
        const blockEl = document.querySelector('messenger-block');
        if (blockEl) {
          const blockData = window.Alpine.$data(blockEl);
          
          const col = shell.activeWorkspace.collection;
          col.events.set("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", {
            id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            header: { kind: "media-item", author: "other-user" },
            body: {
              cleartext: {
                title: "Shared Video",
                url: "http://video.com",
                mediaType: "video/mp4",
                privacy: "public",
                summary: "Shared video description"
              }
            }
          });
          
          const html = blockData.formatMessageBody("Check out this κ:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
          const hasVideo = html.includes("<video") && html.includes("Shared Video");
          return { hasVideo, html };
        }
      }
      return { hasVideo: false, error: "messenger-block not found" };
    });
    assert.ok(chatContentLinking.hasVideo, "Chat parser should render inline HTML video players for resolved media hashes");
    console.log("✓ Chat dynamic content address reference linking verified");

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
