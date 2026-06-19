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
    
    page.on("console", msg => console.log(`BROWSER [${msg.type()}]:`, msg.text()));
    page.on("pageerror", err => console.error("BROWSER ERROR:", err.message));

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
    
    // Verify redirect to the workspace canvas (index.html?id=...)
    console.log("Waiting for redirection to workspace canvas...");
    await page.waitForURL("**/index.html?id=*", { timeout: 15000 });
    console.log("Successfully redirected to world canvas:", page.url());
    
    // Verify that the world block element is present
    console.log("Verifying <world-block> component renders...");
    const worldBlock = page.locator("world-block");
    await worldBlock.waitFor({ timeout: 5000 });
    console.log("Success: <world-block> component is present on the canvas!");
    
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
