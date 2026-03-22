import pkg from "npm:@prisma/client";
const { PrismaClient } = pkg;

/**
 * Note: To use Prisma with Deno Deploy and Postgres, 
 * ensure you have run 'npx prisma generate' locally and 
 * your DATABASE_URL is set in the Deno Deploy environment variables.
 */
const prisma = new PrismaClient();

interface ProxyInfo {
  url: string;
  latency: string;
  country: string;
}

// Memory cache for speed
let workingProxies: ProxyInfo[] = [];
let isScanning = false;

async function checkProxy(proxyAddr: string): Promise<ProxyInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000); 
  const startTime = performance.now();

  try {
    // Deno Deploy does not support Deno.createHttpClient or 'proxy' in fetch.
    // This logic works in Deno CLI (VPS) but will likely fail or ignore proxy in Deploy.
    const res = await fetch("http://ip-api.com/json/?fields=status,countryCode", {
      // @ts-ignore: Deno CLI specific
      proxy: { url: proxyAddr },
      signal: controller.signal,
    });
    
    if (res.ok) {
      const geoData = await res.json();
      const endTime = performance.now();
      if (geoData.status === "success") {
        return {
          url: proxyAddr,
          latency: `${Math.round(endTime - startTime)}ms`,
          country: geoData.countryCode || "??"
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshPool() {
  if (isScanning) return;
  isScanning = true;
  console.log("🔄 Background scan initiated...");

  try {
    const res = await fetch("https://raw.githubusercontent.com/r00tee/Proxy-List/refs/heads/main/Socks5.txt");
    const text = await res.text();
    const raw = text.split("\n")
      .map(p => p.trim())
      .filter(p => p.length > 5)
      .map(p => p.includes("://") ? p : `socks5://${p}`)
      .slice(0, 50);

    const results: ProxyInfo[] = [];
    for (let i = 0; i < raw.length; i += 10) {
      const chunk = raw.slice(i, i + 10);
      const chunkResults = await Promise.all(chunk.map(checkProxy));
      results.push(...chunkResults.filter((p): p is ProxyInfo => p !== null));
    }

    if (results.length > 0) {
      workingProxies = results.sort((a, b) => parseInt(a.latency) - parseInt(b.latency));
      
      try {
        // Clear and update the Postgres database
        // This assumes your model in schema.prisma is named 'Proxy'
        await prisma.$transaction([
          prisma.proxy.deleteMany({}),
          prisma.proxy.createMany({
            data: workingProxies.map(p => ({
              url: p.url,
              latency: p.latency,
              country: p.country
            }))
          })
        ]);
        console.log(`✅ Database synced: ${workingProxies.length} proxies.`);
      } catch (dbErr) {
        console.error("Database Write Error:", dbErr.message);
      }
    }
  } catch (err) {
    console.error("Scan Error:", err.message);
  } finally {
    isScanning = false;
  }
}

Deno.serve(async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Sync memory from Postgres on boot
  if (workingProxies.length === 0) {
    try {
      const saved = await prisma.proxy.findMany({});
      if (saved.length > 0) {
        workingProxies = saved.map(p => ({
          url: p.url,
          latency: p.latency,
          country: p.country
        }));
      }
    } catch (dbErr) {
      console.error("Database Read Error:", dbErr.message);
    }
  }

  const url = new URL(req.url);
  
  if (url.searchParams.get("refresh") === "true" || (workingProxies.length === 0 && !isScanning)) {
    refreshPool();
    if (workingProxies.length === 0) {
      return new Response(
        JSON.stringify([{ url: "Scanning database/web...", latency: "0ms", country: ".." }]), 
        { headers, status: 202 }
      );
    }
  }

  return new Response(JSON.stringify(workingProxies, null, 2), { headers });
});
