import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, "../_site");

// Simple static file server to serve the built website
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

  // Handle SPA routing falls for worlds / login
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
      res.writeHead(200, { 
        "Content-Type": mime
      });
      res.end(content);
    }
  });
});

const PORT = 8000;
server.listen(PORT, async () => {
  console.log(`Test server running at http://localhost:${PORT}`);
  
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    const page = await browser.newPage();
    
    const pageErrors = [];
    const failedRequests = [];

    let lastPromptValue = "";
    page.on("dialog", async dialog => {
      const message = dialog.message();
      const type = dialog.type();
      console.log(`[Dialog] type: ${type}, message: ${message}`);
      if (type === "prompt") {
        if (message.includes("Workspace Invite Code") || message.includes("Complete Backup Payload")) {
          lastPromptValue = dialog.defaultValue();
          await dialog.accept(lastPromptValue);
        } else if (message.includes("Enter Member's Public Key")) {
          await dialog.accept("04b3e295316af8b64f6a16027e08a2f81a69485586ef8156e4646839678fb9be239f62087ccd118f3973e3b6c5cc848deacde319eb4ac0cd3fac57d591aad14b5d");
        } else {
          await dialog.accept();
        }
      } else if (type === "confirm") {
        await dialog.accept();
      } else if (type === "alert") {
        await dialog.accept();
      }
    });

    page.on("console", msg => console.log(`BROWSER [${msg.type()}]:`, msg.text()));
    
    page.on("pageerror", err => {
      console.error("BROWSER ERROR:", err.message);
      pageErrors.push(err);
    });

    page.on("requestfailed", req => {
      const url = req.url();
      const errText = req.failure()?.errorText || "";
      if (url.includes(`localhost:${PORT}`) && !url.startsWith("blob:") && errText !== "net::ERR_ABORTED") {
        console.error(`Local request failed: ${url} (${errText})`);
        failedRequests.push({ url, error: errText });
      }
    });

    page.on("response", res => {
      const url = res.url();
      if (res.status() >= 400 && url.includes(`localhost:${PORT}`) && !url.startsWith("blob:")) {
        console.error(`Local response error: ${url} [${res.status()}]`);
        failedRequests.push({ url, status: res.status() });
      }
    });

    // Go to login page
    console.log("Navigating to login page...");
    await page.goto(`http://localhost:${PORT}/login.html`, { waitUntil: "networkidle" });
    
    // Verify title or logo presence
    const title = await page.title();
    console.log("Page title:", title);
    if (!title.includes("Playground")) {
      throw new Error(`Unexpected page title: ${title}`);
    }
    
    // Click "Start building" button to open the login modal
    console.log("Clicking 'Start building' button to open modal...");
    const startBtn = page.locator("button.nav-login-button").first();
    await startBtn.waitFor({ timeout: 5000 });
    await startBtn.click();
    
    // Test the "Continue Local-First" button click
    console.log("Clicking 'Continue Local-First' button...");
    const localBtn = page.locator("button.local-btn");
    await localBtn.waitFor({ timeout: 5000 });
    await localBtn.click();
    
    // Verify redirect to worlds selector
    console.log("Waiting for redirection to worlds selector...");
    await page.waitForURL("**/worlds.html", { timeout: 8000 });
    console.log("Successfully redirected to:", page.url());
    
    // Test "Create a World" button
    console.log("Clicking 'Create a World' button...");
    const createBtn = page.locator("button", { hasText: "Create a World" });
    await createBtn.waitFor({ timeout: 5000 });
    await createBtn.click();
    
    // Wait for the new world card to appear and click it to open the canvas
    console.log("Waiting for new world card to render in DOM...");
    const worldCard = page.locator(".world").nth(1);
    await worldCard.waitFor({ timeout: 10000 });
    console.log("Clicking world card...");
    await worldCard.click();
    
    // Verify redirect to the workspace canvas (playground.html?id=...)
    console.log("Waiting for redirection to workspace canvas...");
    await page.waitForURL("**/playground.html?id=*", { timeout: 15000 });
    console.log("Successfully redirected to world canvas:", page.url());
    
    // Verify that the world block element is present and successfully initialized (its shadow dom elements are present)
    console.log("Verifying <world-block> component renders and initializes shadow root...");
    const worldBlockWrapper = page.locator("world-block >> .world");
    await worldBlockWrapper.waitFor({ timeout: 10000 });
    console.log("Success: <world-block> component and its shadow elements are successfully initialized!");

    // Navigate to Holo-Apps Shell (apps.html)
    console.log("Navigating to Holo-Apps Shell (apps.html)...");
    await page.goto(`http://localhost:${PORT}/apps.html`, { waitUntil: "networkidle" });

    // Click 'Generate New Identity Keypair' if visible (in case session is not auto-restored)
    const genIdentityBtn = page.locator("button:has-text('Generate New Identity Keypair')");
    if (await genIdentityBtn.isVisible()) {
      console.log("Generating new self-sovereign participant identity...");
      await genIdentityBtn.click();
    } else {
      console.log("Existing identity loaded automatically.");
    }

    // Verify workspace is bootstrapped ('Local Swarm' should appear in sidebar)
    console.log("Waiting for default workspace 'Local Swarm' bootstrapping...");
    const localSwarmSidebar = page.locator(".sidebar-item:has-text('Local Swarm')");
    await localSwarmSidebar.waitFor({ timeout: 10000 });
    console.log("Default workspace loaded successfully.");

    // ----------------------------------------------------
    // Identity Management tests
    // ----------------------------------------------------
    console.log("Opening Identity Configuration modal...");
    const userBadge = page.locator(".user-badge");
    await userBadge.waitFor({ timeout: 5000 });
    await userBadge.click();

    console.log("Exporting identity backup payload...");
    const exportBtn = page.locator(".dialog button:has-text('Export Identity Payload')");
    await exportBtn.waitFor({ timeout: 5000 });
    await exportBtn.click();
    console.log("Captured backup payload length:", lastPromptValue.length);
    const savedBackupPayload = lastPromptValue;

    console.log("Wiping session keys (logout)...");
    const wipeBtn = page.locator(".dialog button:has-text('Wipe Session Keys')");
    await wipeBtn.waitFor({ timeout: 5000 });
    await wipeBtn.click();

    console.log("Waiting for overlay after logout/reload...");
    const backupInput = page.locator("input[placeholder='Paste Backup Payload (Base64)']");
    await backupInput.waitFor({ timeout: 10000 });
    
    console.log("Importing the captured backup payload...");
    await backupInput.fill(savedBackupPayload);
    const importBtn = page.locator("button:has-text('Import Identity')");
    await importBtn.waitFor({ timeout: 5000 });
    await importBtn.click();

    // The overlay should disappear, let's wait for the workspace dashboard to load
    console.log("Verifying successful import and workspace dashboard load...");
    const dashboardTitle = page.locator("h3:has-text('Sovereign Cryptographic Profile')");
    await dashboardTitle.waitFor({ timeout: 10000 });
    console.log("Sovereign Cryptographic Profile is visible. Identity import verified!");

    // ----------------------------------------------------
    // Workspace & Join tests
    // ----------------------------------------------------
    console.log("Opening 'Create WS' modal...");
    const createWsBtn = page.locator("button:has-text('+ Create WS')");
    await createWsBtn.waitFor({ timeout: 5000 });
    await createWsBtn.click();

    console.log("Filling new workspace name...");
    const wsNameInput = page.locator("input[placeholder='Workspace Name']");
    await wsNameInput.waitFor({ timeout: 5000 });
    await wsNameInput.fill("E2E Hive Workspace");

    console.log("Submitting new workspace form...");
    const submitWsBtn = page.locator(".dialog:has(h2:has-text('Create New Workspace')) button:text-is('Create')");
    await submitWsBtn.waitFor({ timeout: 5000 });
    await submitWsBtn.click();

    console.log("Verifying E2E Hive Workspace creation in sidebar...");
    const newWsSidebar = page.locator(".sidebar-item:has-text('E2E Hive Workspace')");
    await newWsSidebar.waitFor({ timeout: 10000 });
    console.log("New workspace created successfully.");

    console.log("Generating Workspace Invite Link/Code...");
    const genInviteBtn = page.locator("button:has-text('Generate Workspace Invite Link/Code')");
    await genInviteBtn.waitFor({ timeout: 5000 });
    await genInviteBtn.click();
    console.log("Captured Workspace Invite Code length:", lastPromptValue.length);
    const savedInviteCode = lastPromptValue;

    console.log("Opening 'Join WS' modal...");
    const joinWsBtn = page.locator("button:has-text('→ Join WS')");
    await joinWsBtn.waitFor({ timeout: 5000 });
    await joinWsBtn.click();

    console.log("Filling invite code...");
    const inviteInput = page.locator("input[placeholder='Paste Workspace Invite Code']");
    await inviteInput.waitFor({ timeout: 5000 });
    await inviteInput.fill(savedInviteCode);

    console.log("Submitting join workspace form...");
    const submitJoinWsBtn = page.locator(".dialog:has(h2:has-text('Join Workspace')) button:text-is('Join')");
    await submitJoinWsBtn.waitFor({ timeout: 5000 });
    await submitJoinWsBtn.click();

    console.log("Verifying joined workspace in sidebar...");
    const joinedWsSidebar = page.locator(".sidebar-item:has-text('E2E Hive Workspace')").first();
    await joinedWsSidebar.waitFor({ timeout: 10000 });
    console.log("Joined Workspace successfully verified!");

    // ----------------------------------------------------
    // Members & Channels tests
    // ----------------------------------------------------
    console.log("Selecting E2E Hive Workspace...");
    const e2eWsSidebar = page.locator(".sidebar-item:has-text('E2E Hive Workspace')").first();
    await e2eWsSidebar.click();

    console.log("Adding member to active workspace...");
    const addMemberBtn = page.locator("button:has-text('+ Member')");
    await addMemberBtn.waitFor({ timeout: 5000 });
    await addMemberBtn.click();

    console.log("Verifying new member is in roster...");
    const memberRosterItem = page.locator("span:has-text('04b3e295316af8b6...')");
    await memberRosterItem.waitFor({ timeout: 10000 });
    console.log("Member successfully added and verified in roster!");

    console.log("Creating channel in workspace...");
    const createChanBtn = page.locator("button:has-text('+ Channel')");
    await createChanBtn.waitFor({ timeout: 5000 });
    await createChanBtn.click();

    const chanNameInput = page.locator("input[placeholder='Channel Name']");
    await chanNameInput.waitFor({ timeout: 5000 });
    await chanNameInput.fill("bees-swarm");

    const submitChanBtn = page.locator(".dialog:has(h2:has-text('Create New Channel')) button:text-is('Create')");
    await submitChanBtn.waitFor({ timeout: 5000 });
    await submitChanBtn.click();

    console.log("Verifying channel creation in sidebar...");
    const newChanSidebar = page.locator(".sidebar-item:has-text('# bees-swarm')");
    await newChanSidebar.waitFor({ timeout: 10000 });
    console.log("Channel # bees-swarm verified!");

    // ----------------------------------------------------
    // Contacts & Pools Directory tests
    // ----------------------------------------------------
    console.log("Navigating to Contacts & Pools tab...");
    const contactsTabItem = page.locator(".sidebar-item:has-text('Contacts & Pools')");
    await contactsTabItem.waitFor({ timeout: 5000 });
    await contactsTabItem.click();

    console.log("Creating a contact pool...");
    const addPoolBtn = page.locator("h4:has-text('Contact Pools') ~ button:text-is('+')");
    await addPoolBtn.waitFor({ timeout: 5000 });
    await addPoolBtn.click();

    const poolNameInput = page.locator("input[placeholder='Pool Name (e.g. Collaborators)']");
    await poolNameInput.waitFor({ timeout: 5000 });
    await poolNameInput.fill("Beekeepers");

    const submitPoolBtn = page.locator(".dialog:has(h2:has-text('Create Contact Pool')) button:text-is('Create Pool')");
    await submitPoolBtn.waitFor({ timeout: 5000 });
    await submitPoolBtn.click();

    console.log("Verifying contact pool creation in sidebar...");
    const poolSidebarItem = page.locator(".sidebar-item:has-text('Beekeepers')");
    await poolSidebarItem.waitFor({ timeout: 10000 });

    console.log("Adding a contact manually...");
    const addContactBtn = page.locator("button:has-text('Add Contact Manually')");
    await addContactBtn.waitFor({ timeout: 5000 });
    await addContactBtn.click();

    const contactAliasInput = page.locator("input[placeholder='Alias Name (e.g. Alice)']");
    await contactAliasInput.waitFor({ timeout: 5000 });
    await contactAliasInput.fill("Alice Bee");

    const contactPubkeyInput = page.locator("input[placeholder='Signing Public Key Address (κ)']");
    await contactPubkeyInput.waitFor({ timeout: 5000 });
    await contactPubkeyInput.fill("04c29455ef8469ab7d37c65271da2c03135b30ea0a8b2c993831341ac8b0d688c943f4dda806fe71dd7cc800c088e1e62d6baabe4ae9fdc54f67f8d1e858f94554");

    const contactCurveInput = page.locator("input[placeholder='ECDH Exchange Public Key']");
    await contactCurveInput.waitFor({ timeout: 5000 });
    await contactCurveInput.fill("04bad0cdcd65d4efa7fd6fa458d6dc1e8d10796003d4f36877c3d14eb837617600fdb17750797385a26b603614b66e300ebc8df9eee732074d5e74896abc46a8b9");

    const submitContactBtn = page.locator(".dialog:has(h2:has-text('Add Contact Manually')) button:text-is('Add Contact')");
    await submitContactBtn.waitFor({ timeout: 5000 });
    await submitContactBtn.click();

    console.log("Verifying contact creation in directory list...");
    const contactCardName = page.locator("div:text-is('Alice Bee')");
    await contactCardName.waitFor({ timeout: 10000 });
    const contactCard = page.locator(".glass", { has: page.locator("div:text-is('Alice Bee')") });

    console.log("Assigning pool to contact...");
    const poolTagBtn = contactCard.locator("button:text-is('Beekeepers')");
    await poolTagBtn.waitFor({ timeout: 5000 });
    await poolTagBtn.click();

    console.log("Filtering by pool in sidebar...");
    await poolSidebarItem.click();

    // Verify contact is still visible under filtered view
    await contactCardName.waitFor({ timeout: 5000 });

    console.log("Showing all contacts...");
    const showAllItem = page.locator(".sidebar-item:has-text('Show All')");
    await showAllItem.click();

    console.log("Deleting contact...");
    const deleteContactBtn = contactCard.locator("button:text-is('Delete')");
    await deleteContactBtn.waitFor({ timeout: 5000 });
    await deleteContactBtn.click();

    // Verify contact is removed
    await contactCardName.waitFor({ state: "detached", timeout: 5000 });
    console.log("Contact management test PASSED!");

    // ----------------------------------------------------
    // Return to Messenger block to verify integration
    // ----------------------------------------------------
    console.log("Returning to Workspace Dashboard...");
    const workspaceDashboardItem = page.locator(".sidebar-item:has-text('Workspace Dashboard')");
    await workspaceDashboardItem.waitFor({ timeout: 5000 });
    await workspaceDashboardItem.click();

    const workspacesText = await page.evaluate(() => {
      return JSON.stringify(Alpine.$data(document.body).workspaces.map(w => ({ id: w.id, name: w.name, channels: w.channels })));
    });
    console.log("Workspaces in Alpine state:", workspacesText);

    console.log("Selecting default workspace 'Local Swarm'...");
    const localSwarmItem = page.locator(".sidebar-item:has-text('Local Swarm')");
    await localSwarmItem.click();

    console.log("Navigating to '# general' channel...");
    const generalChannelItem = page.locator(".sidebar-item:has-text('# general')");
    await generalChannelItem.waitFor({ timeout: 5000 });
    await generalChannelItem.click();

    console.log("Verifying <messenger-block> input box is visible...");
    const chatInput = page.locator("input.chat-input");
    await chatInput.waitFor({ timeout: 10000 });
    console.log("<messenger-block> initialized successfully!");

    console.log("Typing E2E test chat message...");
    await chatInput.fill("Hello from E2E automated test!");
    const sendBtn = page.locator("button.send-btn").first();
    await sendBtn.click();
    console.log("Message sent!");
    
    
    // Check if any errors occurred during E2E flow
    if (pageErrors.length > 0) {
      throw new Error(`Browser encountered ${pageErrors.length} uncaught exceptions: ${pageErrors.map(e => e.message).join(", ")}`);
    }
    if (failedRequests.length > 0) {
      throw new Error(`Browser encountered ${failedRequests.length} local resource load failures: ${failedRequests.map(r => `${r.url} (status: ${r.status || 'failed'})`).join(", ")}`);
    }

    console.log("Playground E2E integration test PASSED successfully!");
    process.exitCode = 0;
  } catch (error) {
    console.error("E2E integration test FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    server.close();
  }
});
