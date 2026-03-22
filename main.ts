interface ProxyInfo {
  url: string;
  latency: string;
  country: string;
}

// Global pool of working proxies
let workingProxies: ProxyInfo[] = [];
let isInitialLoading = true;

async function checkProxy(proxyAddr: string): Promise<ProxyInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000); // 6 second timeout
  const startTime = performance.now();

  try {
    // We use a dedicated proxy fetch approach
    // Note: Deno.createHttpClient is the standard way to route a fetch through a proxy
    const client = Deno.createHttpClient({ 
      proxy: { url: proxyAddr }
    });
    
    // Testing against a very fast, reliable API
    const res = await fetch("http://ip-api.com/json/?fields=status,countryCode", {
      client,
      signal: controller.signal,
    });
    
    const body = await res.json();
    const endTime = performance.now();
    const latency = Math.round(endTime - startTime);

    client.close();

    if (body && body.status === "success") {
      return {
        url: proxyAddr,
        latency: `${latency}ms`,
        country: body.countryCode || "??",
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshPool() {
  console.log("🔄 Starting fresh proxy scan...");
  try {
    // Fetching from a secondary source as well for better diversity
    const res = await fetch("https://raw.githubusercontent.com/r00tee/Proxy-List/refs/heads/main/Socks5.txt");
    const text = await res.text();
    
    const raw = text.split("\n")
      .map(p => p.trim())
      .filter(p => p.length > 5)
      .map(p => `http://${p}`)
      .slice(0, 200); // Check 200 proxies to guarantee results

    console.log(`📡 Testing ${raw.length} candidates in parallel chunks...`);

    const results: ProxyInfo[] = [];
    const chunkSize = 25; // Check 25 at a time
    
    for (let i = 0; i < raw.length; i += chunkSize) {
      const chunk = raw.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(chunk.map(checkProxy));
      const validOnes = chunkResults.filter((p): p is ProxyInfo => p !== null);
      results.push(...validOnes);
      
      console.log(`| Progress: ${i + chunk.length}/${raw.length} | Found so far: ${results.length}`);
    }

    if (results.length > 0) {
      workingProxies = results.sort((a, b) => parseInt(a.latency) - parseInt(b.latency));
      console.log(`✅ Scan Complete: ${workingProxies.length} proxies are ready.`);
    } else {
      console.log("⚠️ Scan failed to find active proxies. Retrying in 30s...");
      setTimeout(refreshPool, 30000); 
    }
  } catch (err) {
    console.error("❌ Critical Error:", err.message);
  } finally {
    isInitialLoading = false;
  }
}

// Initial fetch
refreshPool();

// Refresh pool every 15 minutes
setInterval(refreshPool, 15 * 60 * 1000);

Deno.serve({ port: 8000 }, (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (req.method === "OPTIONS") return new Response(null, { headers });

  if (isInitialLoading && workingProxies.length === 0) {
    return new Response(JSON.stringify([{ url: "System Booting...", latency: "---", country: ".." }]), { headers });
  }

  return new Response(JSON.stringify(workingProxies), { headers });
});
