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

    // Test creating a new workspace
    console.log("Opening 'Create WS' modal...");
    const createWsBtn = page.locator("button:has-text('+ Create WS')");
    await createWsBtn.waitFor({ timeout: 5000 });
    await createWsBtn.click();

    // Input new workspace name
    console.log("Filling new workspace name...");
    const wsNameInput = page.locator("input[placeholder='Workspace Name']");
    await wsNameInput.waitFor({ timeout: 5000 });
    await wsNameInput.fill("E2E Hive Workspace");

    // Click 'Create' button inside the modal
    console.log("Submitting new workspace form...");
    const submitWsBtn = page.locator("button:text-is('Create')");
    await submitWsBtn.waitFor({ timeout: 5000 });
    await submitWsBtn.click();

    // Verify the new workspace appears in the sidebar and is active
    console.log("Verifying E2E Hive Workspace creation in sidebar...");
    const newWsSidebar = page.locator(".sidebar-item:has-text('E2E Hive Workspace')");
    await newWsSidebar.waitFor({ timeout: 10000 });
    console.log("Success: New workspace created and active!");

    // Select default workspace 'Local Swarm' to test channel & messenger block
    console.log("Selecting default workspace 'Local Swarm'...");
    const localSwarmItem = page.locator(".sidebar-item:has-text('Local Swarm')");
    await localSwarmItem.click();

    // Click the '# general' channel
    console.log("Navigating to '# general' channel...");
    const generalChannelItem = page.locator(".sidebar-item:has-text('# general')");
    await generalChannelItem.waitFor({ timeout: 5000 });
    await generalChannelItem.click();

    // Verify <messenger-block> renders and its input box is visible
    console.log("Verifying <messenger-block> input box is visible...");
    const chatInput = page.locator("input.chat-input");
    await chatInput.waitFor({ timeout: 10000 });
    console.log("<messenger-block> initialized successfully!");

    // Type and send a message
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
