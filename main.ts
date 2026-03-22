interface ProxyInfo {
  url: string;
  latency: string;
  country: string;
}

// Global pool of working proxies
let workingProxies: ProxyInfo[] = [];
let isInitialLoading = true;

/**
 * Checks a single proxy for connectivity and latency.
 * Uses the modern fetch API with proxy support.
 */
async function checkProxy(proxyAddr: string): Promise<ProxyInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 8 second timeout
  const startTime = performance.now();

  try {
    // Note: Deno 2.0+ uses standard fetch options for proxies
    // If running on older Deno, createHttpClient might be required, 
    // but the following is the standard forward-compatible way.
    const response = await fetch("http://ip-api.com/json/?fields=status,countryCode", {
      // @ts-ignore: Deno specific proxy property
      proxy: { url: proxyAddr },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const body = await response.json();
    const endTime = performance.now();
    const latency = Math.round(endTime - startTime);

    if (body && body.status === "success") {
      return {
        url: proxyAddr,
        latency: `${latency}ms`,
        country: body.countryCode || "??",
      };
    }
    return null;
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches the raw list, cleans it, and runs parallel checks in chunks.
 */
async function refreshPool() {
  console.log(`[${new Date().toISOString()}] 🔄 Starting proxy scan...`);
  
  try {
    // Fetching SOCKS5 list as requested
    const res = await fetch("https://raw.githubusercontent.com/r00tee/Proxy-List/refs/heads/main/Socks5.txt");
    if (!res.ok) throw new Error("Failed to fetch proxy list source");
    
    const text = await res.text();
    const rawLines = text.split("\n")
      .map(p => p.trim())
      .filter(p => p.length > 5);

    // Format lines: Ensure they have a protocol. 
    // Since the source is Socks5.txt, we prepended socks5://
    const candidates = rawLines
      .slice(0, 300) // Increase sample size for better probability
      .map(p => p.startsWith("socks5://") ? p : `socks5://${p}`);

    console.log(`📡 Testing ${candidates.length} candidates in chunks...`);

    const validResults: ProxyInfo[] = [];
    const chunkSize = 30; // Processing 30 at a time to stay under descriptor limits
    
    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(chunk.map(checkProxy));
      
      const successful = chunkResults.filter((p): p is ProxyInfo => p !== null);
      validResults.push(...successful);
      
      console.log(`| Progress: ${Math.min(i + chunkSize, candidates.length)}/${candidates.length} | Found: ${validResults.length}`);
    }

    if (validResults.length > 0) {
      // Sort by fastest latency
      workingProxies = validResults.sort((a, b) => parseInt(a.latency) - parseInt(b.latency));
      console.log(`✅ Scan Complete: ${workingProxies.length} proxies active.`);
    } else {
      console.log("⚠️ No active proxies found this cycle. Keeping previous list.");
    }
  } catch (err) {
    console.error("❌ Scan Error:", err instanceof Error ? err.message : String(err));
  } finally {
    isInitialLoading = false;
  }
}

// Initial fetch
refreshPool();

// Refresh pool every 15 minutes to keep list "warm"
setInterval(refreshPool, 15 * 60 * 1000);

// Start Deno Server
Deno.serve({ port: 8000 }, (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  // Health check or early return during first boot
  if (isInitialLoading && workingProxies.length === 0) {
    return new Response(
      JSON.stringify({ status: "loading", message: "Initial proxy scan in progress..." }), 
      { headers, status: 202 }
    );
  }

  // Return the sorted list of working proxies
  return new Response(JSON.stringify(workingProxies, null, 2), { 
    headers, 
    status: workingProxies.length > 0 ? 200 : 503 
  });
});
