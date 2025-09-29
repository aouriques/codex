// server.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { chromium } from "playwright";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map(); // jobId -> { status, logs:[], results:[], startedAt, finishedAt }

function log(job, msg) {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    job.logs.push(`[${ts}] ${msg}`);
}
function sanitizeFilename(s) {
    return s.replace(/[\/\\?%*:|"<>]/g, "_").slice(0, 120);
}

/** Prevent common consent UIs from rendering (block scripts + pre-inject CSS/observer + seed consent) */
async function hardBlockConsent(context) {
    await context.route(/lanyard|consent|cmp|cookiebot|onetrust|didomi|quantcast|trustarc|osano/i, r => r.abort());
    await context.addInitScript(() => {
        try {
            const style = document.createElement('style');
            style.textContent = `
        #lanyard_root { display:none!important; visibility:hidden!important; opacity:0!important; }
        #lanyard_root * { display:none!important; }
        html, body, * { scroll-behavior: auto !important; } /* kill smooth scroll that can clamp */
      `;
            document.documentElement.appendChild(style);

            const kill = (node) => {
                try {
                    if (!node || node.nodeType !== 1) return;
                    if (node.id === 'lanyard_root') { node.remove(); return; }
                    const s = getComputedStyle(node);
                    const area = node.clientWidth * node.clientHeight;
                    if ((s.position === 'fixed' || s.position === 'sticky') &&
                        area > innerWidth * innerHeight * 0.25 &&
                        /cookie|consent|privacy|cmp|lanyard/i.test(node.innerText || '')) {
                        node.remove();
                    }
                } catch {}
            };
            new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(kill)))
                .observe(document.documentElement, { childList: true, subtree: true });

            const expires = new Date(Date.now() + 31536000000).toUTCString();
            document.cookie = `cookie_consent=accepted; path=/; expires=${expires}; SameSite=Lax`;
            try { localStorage.setItem('cookie_consent', 'accepted'); } catch {}
            try { localStorage.setItem('consentAccepted', 'true'); } catch {}
            try { localStorage.setItem('cookiesAccepted', 'true'); } catch {}
        } catch {}
    });
}

/** Defensive closer (iframes + shadow DOM) if anything slips through */
async function closeCookies(page, { timeoutMs = 800 } = {}) {
    const selectors = [
        '#onetrust-accept-btn-handler',
        'button#onetrust-accept-btn-handler',
        ':light(button:has-text("Accept all"))',
        ':light(button:has-text("Accept All"))',
        ':light(button:has-text("Accept"))',
        ':light(button:has-text("I Accept"))',
        ':light(button:has-text("Agree"))',
        ':light(button:has-text("Allow all"))',
        ':light(button:has-text("Accept cookies"))',
        ':light(button:has-text("Accept & close"))',
        '#didomi-notice-agree-button',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '.truste-button1',
        '.qc-cmp2-summary-buttons button[mode="primary"]',
        '.osano-cm-accept',
        '#lanyard_root :is(button, [role="button"])'
    ];
    async function tryOn(target) {
        for (const sel of selectors) {
            const btn = target.locator(sel).first();
            if (await btn.count()) {
                try {
                    await btn.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
                    await btn.click({ timeout: timeoutMs, trial: true }).catch(() => {});
                    await btn.click({ timeout: timeoutMs, force: true }).catch(() => {});
                    await target.waitForTimeout(120);
                    const still = await btn.isVisible().catch(() => false);
                    if (!still) return true;
                } catch {}
            }
        }
        const names = [
            /accept all/i, /accept cookies?/i, /accept & close/i, /allow all/i, /agree/i, /got it/i,
            /aceitar/i, /concordo/i, /aceitar todos/i,
            /accepter/i, /tout accepter/i,
            /akzeptieren/i, /alle akzeptieren/i,
            /aceptar/i, /aceptar todo/i
        ];
        for (const re of names) {
            const btn = target.getByRole('button', { name: re }).first();
            if (await btn.count()) {
                await btn.click({ timeout: timeoutMs, force: true }).catch(() => {});
                await target.waitForTimeout(120);
                const still = await btn.isVisible().catch(() => false);
                if (!still) return true;
            }
        }
        return false;
    }
    if (await tryOn(page)) return true;
    for (const f of page.frames()) {
        try { if (await tryOn(f)) return true; } catch {}
    }
    return false;
}

/**
 * rAF-based scroller that auto-detects the real scrollable container.
 * Returns telemetry so we can verify actual speed used.
 */
async function rAFScrollAuto(page, { pixelsPerSecond, preRollMs = 500, postRollMs = 500, networkIdleWaitMs = 1500 }) {
    await page.addStyleTag({ content: `
    * { scroll-behavior: auto !important; }
    html, body { overscroll-behavior: none !important; }
  `});
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.waitForLoadState("domcontentloaded");
    try { await page.waitForLoadState("networkidle", { timeout: networkIdleWaitMs }); } catch {}
    if (preRollMs > 0) await page.waitForTimeout(preRollMs);

    // Poll for late banners while we scroll (defensive)
    let cookieScanBusy = false;
    const poll = setInterval(async () => {
        if (cookieScanBusy) return;
        cookieScanBusy = true;
        try { await closeCookies(page, { timeoutMs: 500 }); } finally { cookieScanBusy = false; }
    }, 1000);

    const telemetry = await page.evaluate(async (pps) => {
        // detect the main scroller
        function detectScroller() {
            let best = document.scrollingElement || document.documentElement;
            let bestRange = (best.scrollHeight - best.clientHeight) || 0;

            const all = document.querySelectorAll("*");
            for (const el of all) {
                try {
                    const cs = getComputedStyle(el);
                    if (!/(auto|scroll|overlay)/i.test(cs.overflowY)) continue;
                    const range = el.scrollHeight - el.clientHeight;
                    if (range > bestRange + 5) {
                        best = el;
                        bestRange = range;
                    }
                } catch {}
            }
            // Produce a readable selector-ish label
            const id = best.id ? `#${best.id}` : "";
            const cls = best.className && typeof best.className === "string"
                ? "." + best.className.trim().split(/\s+/).slice(0,2).join(".")
                : "";
            const tag = best.tagName ? best.tagName.toLowerCase() : "unknown";
            return { el: best, label: `${tag}${id}${cls}`, range: bestRange };
        }

        const pick = detectScroller();
        const scroller = pick.el;
        const label = pick.label;

        // total scrollable distance
        const total = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const startY = scroller.scrollTop;

        const t0 = performance.now();
        let last = t0;

        await new Promise(resolve => {
            function step(now) {
                const dt = now - last;
                last = now;

                const dy = (pps * dt) / 1000; // pixels this frame
                const next = Math.min(scroller.scrollTop + dy, total);
                scroller.scrollTop = next;

                // also guard against sites that try to smooth-scroll
                // (setting directly each frame overrides that)
                if (next >= total - 1) resolve();
                else requestAnimationFrame(step);
            }
            requestAnimationFrame(step);
        });

        const t1 = performance.now();
        const durationMs = t1 - t0;
        const moved = (scroller.scrollTop - startY);
        const avgPps = moved > 0 ? (moved / (durationMs / 1000)) : 0;

        return {
            scroller: label,
            totalPixels: total,
            movedPixels: moved,
            durationMs,
            avgPps
        };
    }, Math.max(10, Number(pixelsPerSecond) || 60));

    clearInterval(poll);
    if (postRollMs > 0) await page.waitForTimeout(postRollMs);

    return telemetry;
}

async function recordOne({ url, outDir, videoWidth, videoHeight, deviceScaleFactor, pixelsPerSecond }, job) {
    const titleSlug = sanitizeFilename(url.replace(/^https?:\/\//, ""));
    const perUrlDir = path.join(outDir, titleSlug);
    fs.mkdirSync(perUrlDir, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: videoWidth, height: videoHeight },
        deviceScaleFactor,
        recordVideo: {
            dir: perUrlDir,
            size: { width: videoWidth, height: videoHeight }
        }
    });

    await hardBlockConsent(context);
    const page = await context.newPage();

    try {
        log(job, `Opening ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await closeCookies(page);

        log(job, `Target speed: ${pixelsPerSecond} px/s`);
        const tel = await rAFScrollAuto(page, {
            pixelsPerSecond,
            networkIdleWaitMs: 1500,
            preRollMs: 500,
            postRollMs: 500
        });
        log(job, `Scroller: ${tel.scroller}`);
        log(job, `Moved: ${Math.round(tel.movedPixels)}px of ${Math.round(tel.totalPixels)}px in ${Math.round(tel.durationMs)}ms (avg ${Math.round(tel.avgPps)} px/s)`);

        const video = page.video();
        await page.close();

        const raw = await video.path();
        const outName = sanitizeFilename(`${new Date().toISOString().replace(/[:.]/g, "-")}__${titleSlug}.webm`);
        const finalPath = path.join(perUrlDir, outName);
        fs.renameSync(raw, finalPath);
        log(job, `Saved: ${finalPath}`);
        return finalPath;
    } catch (err) {
        log(job, `Error on ${url}: ${err.message || err}`);
        try { await page.close(); } catch {}
        throw err;
    } finally {
        await context.close();
        await browser.close();
    }
}

// ------------------------------- API ---------------------------------------
app.post("/api/record", async (req, res) => {
    const { urls = "", scrollSpeed = 60 } = req.body || {}; // px/s
    const list = String(urls).split("\n").map(s => s.trim()).filter(Boolean);
    if (list.length === 0) return res.status(400).json({ error: "No URLs provided." });

    const pps = Math.max(10, Number(scrollSpeed) || 60);
    const outDir = path.resolve("./recordings");
    fs.mkdirSync(outDir, { recursive: true });

    const jobId = crypto.randomUUID();
    const job = { status: "queued", logs: [], results: [], startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(jobId, job);
    res.json({ jobId });

    (async () => {
        job.status = "running";
        log(job, `Received ${list.length} URL(s). Using speed: ${pps} px/s`);
        try {
            for (const url of list) {
                const file = await recordOne({
                    url,
                    outDir,
                    videoWidth: 1920,   // fixed 1080p to keep UI minimal
                    videoHeight: 1080,
                    deviceScaleFactor: 1.0,
                    pixelsPerSecond: pps
                }, job);
                job.results.push({ url, file });
            }
            job.status = "done";
            job.finishedAt = new Date().toISOString();
            log(job, "All recordings completed.");
        } catch (e) {
            job.status = "error";
            job.finishedAt = new Date().toISOString();
            log(job, `Job failed: ${e.message || e}`);
        }
    })();
});

app.get("/api/status/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found." });
    res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`UI: http://localhost:${PORT}`);
});
