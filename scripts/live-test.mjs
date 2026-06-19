import { chromium } from "playwright";

const LIVE_URL = "https://afflom.github.io/holowhat";

async function runLiveTest() {
  console.log(`Starting Live E2E test against: ${LIVE_URL}`);
  
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    const page = await browser.newPage();
    
    const pageErrors = [];
    const failedRequests = [];

    // Capture console output and log it
    page.on("console", msg => {
      console.log(`BROWSER [${msg.type()}]:`, msg.text());
      // Fail on console error severity
      if (msg.type() === "error") {
        console.error("BROWSER CONSOLE ERROR:", msg.text());
        pageErrors.push(new Error(`Console error: ${msg.text()}`));
      }
    });
    
    // Capture uncaught script exceptions
    page.on("pageerror", err => {
      console.error("BROWSER UNCAUGHT EXCEPTION:", err.message);
      pageErrors.push(err);
    });

    // Capture failed resource requests (e.g. 404, blocked)
    page.on("requestfailed", req => {
      const url = req.url();
      if (url.includes("afflom.github.io")) {
        console.error(`Live resource request failed: ${url} (${req.failure()?.errorText})`);
        failedRequests.push({ url, error: req.failure()?.errorText });
      }
    });

    // Capture status code errors
    page.on("response", res => {
      const url = res.url();
      if (res.status() >= 400 && url.includes("afflom.github.io")) {
        console.error(`Live resource response error: ${url} [${res.status()}]`);
        failedRequests.push({ url, status: res.status() });
      }
    });

    // 1. Navigate to Live Login Page
    console.log("Navigating to live login page...");
    await page.goto(`${LIVE_URL}/login.html`, { waitUntil: "networkidle" });
    
    // Verify Title
    const title = await page.title();
    console.log("Page title:", title);
    if (!title.includes("Playground")) {
      throw new Error(`Unexpected page title: ${title}`);
    }
    
    // 2. Click 'Start building' to open login modal
    console.log("Clicking 'Start building' button to open modal...");
    const startBtn = page.locator("button.nav-login-button").first();
    await startBtn.waitFor({ timeout: 5000 });
    await startBtn.click();
    
    // 3. Click 'Continue Local-First'
    console.log("Clicking 'Continue Local-First' button...");
    const localBtn = page.locator("button.local-btn");
    await localBtn.waitFor({ timeout: 5000 });
    await localBtn.click();
    
    // 4. Verify Redirection to Worlds Selector
    console.log("Waiting for redirection to worlds selector...");
    await page.waitForURL("**/worlds.html", { timeout: 8000 });
    console.log("Successfully redirected to worlds selector:", page.url());
    
    // 5. Create a new world
    console.log("Clicking 'Create a World' button...");
    const createBtn = page.locator("button", { hasText: "Create a World" });
    await createBtn.waitFor({ timeout: 5000 });
    await createBtn.click();
    
    // 6. Wait for the new world card to render in the DOM and click it
    console.log("Waiting for new world card to render in DOM...");
    const worldCard = page.locator(".world").nth(1);
    await worldCard.waitFor({ timeout: 10000 });
    console.log("Clicking world card...");
    await worldCard.click();
    
    // 7. Verify Redirection to Workspace Canvas
    console.log("Waiting for redirection to workspace canvas...");
    await page.waitForURL("**/index.html?id=*", { timeout: 15000 });
    console.log("Successfully redirected to world canvas:", page.url());
    
    // 8. Verify <world-block> component renders and is successfully initialized
    console.log("Verifying <world-block> component renders and initializes shadow root...");
    const worldBlockWrapper = page.locator("world-block >> .world");
    await worldBlockWrapper.waitFor({ timeout: 15000 });
    console.log("Success: <world-block> component and its shadow elements are successfully initialized!");
    
    // 8b. Navigate to Holo-Apps Shell
    console.log("Navigating to live holo-apps shell (apps.html)...");
    await page.goto(`${LIVE_URL}/apps.html`, { waitUntil: "networkidle" });
    
    // Check if sign-in button exists and click it
    console.log("Clicking 'Generate New Identity Keypair' button...");
    const genIdentityBtn = page.locator("button:has-text('Generate New Identity Keypair')");
    await genIdentityBtn.waitFor({ timeout: 5000 });
    await genIdentityBtn.click();
    
    // Verify Dashboard view
    console.log("Verifying Sovereign Cryptographic Profile is displayed...");
    const profileHdr = page.locator("h3:has-text('Sovereign Cryptographic Profile')");
    await profileHdr.waitFor({ timeout: 5000 });
    
    // Create new channel
    console.log("Creating a new channel...");
    const createChBtn = page.locator("button:has-text('+ Create Channel')");
    await createChBtn.click();
    
    const channelNameInput = page.locator("input[placeholder='Channel Name']");
    await channelNameInput.waitFor({ timeout: 5000 });
    await channelNameInput.fill("E2E Test Channel");
    
    const submitCreateChBtn = page.locator("button", { hasText: /^Create$/ });
    await submitCreateChBtn.click();
    
    // Verify Channel created and listed
    console.log("Selecting the created channel...");
    const channelListItem = page.locator("li.sidebar-item:has-text('E2E Test Channel')");
    await channelListItem.waitFor({ timeout: 5000 });
    await channelListItem.click();
    
    // Send a message
    console.log("Sending a message in channel...");
    const messageInput = page.locator("input[placeholder='Type a message...']");
    await messageInput.waitFor({ timeout: 5000 });
    await messageInput.fill("Automated Live E2E Message");
    await page.keyboard.press("Enter");
    
    // Verify message rendered
    console.log("Verifying message is rendered in the transcript...");
    const messageItem = page.locator(".message-body:has-text('Automated Live E2E Message')");
    await messageItem.waitFor({ timeout: 8000 });
    console.log("Holo-Apps Shell live E2E verification passed successfully!");
    
    // 9. Check if any errors occurred during E2E flow
    if (pageErrors.length > 0) {
      throw new Error(`Browser encountered ${pageErrors.length} warnings/exceptions: ${pageErrors.map(e => e.message).join(", ")}`);
    }
    if (failedRequests.length > 0) {
      throw new Error(`Browser encountered ${failedRequests.length} resource load failures: ${failedRequests.map(r => `${r.url} (status: ${r.status || 'failed'})`).join(", ")}`);
    }

    console.log("Live production E2E integration test PASSED successfully!");
    process.exitCode = 0;
  } catch (error) {
    console.error("Live production E2E integration test FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

runLiveTest();
