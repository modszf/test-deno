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
  const timeout = setTimeout(() => controller.abort(), 5000); // Increased timeout to 5s
  const startTime = performance.now();

  try {
    const client = Deno.createHttpClient({ 
      proxy: { url: proxyAddr },
      // Added for better compatibility
      allowHost: true 
    });
    
    // Using a more reliable field set for ip-api
    const res = await fetch("http://ip-api.com/json/?fields=status,message,countryCode,query", {
      client,
      signal: controller.signal,
    });
    
    const endTime = performance.now();
    const latency = Math.round(endTime - startTime);

    if (res.ok) {
      const geoData = await res.json();
      client.close();
      
      if (geoData.status === "success") {
        return {
          url: proxyAddr,
          latency: `${latency}ms`,
          country: geoData.countryCode
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
  console.log("🔄 Fetching fresh proxy list...");
  try {
    const res = await fetch("https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt");
    const text = await res.text();
    
    // Increased slice to 100 to get a higher chance of finding working ones
    const raw = text.split("\n")
      .map(p => p.trim())
      .filter(p => p.length > 5)
      .map(p => `http://${p}`)
      .slice(0, 100); 

    console.log(`📡 Testing ${raw.length} candidates...`);

    // Process in smaller chunks to avoid overwhelming the network
    const results: ProxyInfo[] = [];
    const chunkSize = 20;
    for (let i = 0; i < raw.length; i += chunkSize) {
      const chunk = raw.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(chunk.map(checkProxy));
      results.push(...chunkResults.filter((p): p is ProxyInfo => p !== null));
    }

    if (results.length > 0) {
      // Only overwrite the global pool if we actually found working proxies
      workingProxies = results.sort((a, b) => parseInt(a.latency) - parseInt(b.latency));
      console.log(`✅ Success! Found ${workingProxies.length} working proxies.`);
    } else {
      console.log("⚠️ No working proxies found in this cycle. Keeping previous list.");
    }
  } catch (err) {
    console.error("❌ Error refreshing pool:", err);
  } finally {
    isInitialLoading = false;
  }
}

// Initial fetch
refreshPool();

// Refresh every 10 minutes
setInterval(refreshPool, 10 * 60 * 1000);

Deno.serve({ port: 8000 }, (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // If still loading and pool is empty, provide a message or wait
  if (isInitialLoading && workingProxies.length === 0) {
    return new Response(JSON.stringify([{ url: "loading...", latency: "0ms", country: ".." }]), { headers });
  }

  return new Response(JSON.stringify(workingProxies), { headers });
});
