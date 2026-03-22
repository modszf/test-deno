import { PrismaClient } from "npm:@prisma/client";

// Initialize Prisma Client
// Ensure your DATABASE_URL environment variable is set in Deno Deploy
const prisma = new PrismaClient();

interface ProxyInfo {
  url: string;
  latency: string;
  country: string;
}

// Memory cache for speed
let workingProxies: ProxyInfo[] = [];
let isScanning = false;

/**
 * Note: Deno Deploy has limitations on 'proxy' options in fetch.
 * Standard fetch on Deno Deploy might ignore the proxy object.
 */
async function checkProxy(proxyAddr: string): Promise<ProxyInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000); 
  const startTime = performance.now();

  try {
    const res = await fetch("http://ip-api.com/json/?fields=status,countryCode", {
      // @ts-ignore: Deno CLI specific proxy property
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
      
      // Save to Prisma Postgres
      // We upsert or replace the list. Using a simple approach for this example:
      try {
        // Clearing old proxies and inserting new ones 
        // (Alternatively, use a single JSON field in a "Settings" table)
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
        console.log(`✅ Saved ${workingProxies.length} proxies to Prisma Postgres.`);
      } catch (dbErr) {
        console.error("Database Save Error:", dbErr);
      }
    }
  } catch (err) {
    console.error("Scan Error:", err);
  } finally {
    isScanning = false;
  }
}

Deno.serve(async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // 1. Try to sync memory with Postgres if memory is empty
  if (workingProxies.length === 0) {
    try {
      const savedProxies = await prisma.proxy.findMany({
        orderBy: { id: 'asc' }
      });
      if (savedProxies.length > 0) {
        workingProxies = savedProxies.map(p => ({
          url: p.url,
          latency: p.latency,
          country: p.country
        }));
        console.log("📦 Loaded proxies from Prisma Postgres");
      }
    } catch (dbErr) {
      console.error("Database Read Error:", dbErr);
    }
  }

  const url = new URL(req.url);
  
  // 2. Handle refresh request or initial empty state
  if (url.searchParams.get("refresh") === "true" || (workingProxies.length === 0 && !isScanning)) {
    refreshPool();
    if (workingProxies.length === 0) {
      return new Response(
        JSON.stringify([{ url: "Scanning... please refresh in 10s", latency: "0ms", country: ".." }]), 
        { headers, status: 202 }
      );
    }
  }

  // 3. Always return the list
  return new Response(JSON.stringify(workingProxies, null, 2), { headers });
});
